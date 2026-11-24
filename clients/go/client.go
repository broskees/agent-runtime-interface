// Package ari drives an ARI driver over ari/wire: newline-delimited JSON-RPC 2.0 on the stdio of an
// ari-driver process (the standalone executable needs no Node).
//
// The wire types, one method per call a host makes (Client.SessionStartTurn, ...) and the Host
// interface with one method per call a driver makes (host/*) are generated from ARI's json-schema/
// and spec/v1/methods.json into generated.go. This file holds only the framing:
//
//   - Our requests get ids 1, 2, 3, ...; the driver's requests are answered by the Host in their
//     own goroutines while our calls are pending, so a driver that calls the host before it answers
//     us never deadlocks.
//   - A stream (SessionEvents, ...) is registered by the reader when the response carrying its
//     streamId arrives, before the reader looks at the next frame, so no item is lost.
//   - When the driver's output ends, every pending call and every open stream fails with transport.
//
// Every tagged union (AriEventBody, CallError, ContentBlock, ...) keeps a variant this client does
// not know, such as an x: extension event, as Unrecognized<Union> with its raw JSON, and every enum
// is a string type that keeps any value.
package ari

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	callErrorCode     = -32000
	methodNotFound    = -32601
	invalidParamsCode = -32602
)

var coreMethods = []string{"initialize", "stream/end", "stream/cancel"}

// Null is the JSON null a void call answers.
type Null struct{}

func (Null) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

func (*Null) UnmarshalJSON([]byte) error { return nil }

// Nullable is an optional field that may also be null: absent (the zero value), null (Null), or a
// value (Set with Value).
type Nullable[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// Some is a Nullable holding value.
func Some[T any](value T) Nullable[T] { return Nullable[T]{Set: true, Value: value} }

// None is a Nullable holding a JSON null.
func None[T any]() Nullable[T] { return Nullable[T]{Set: true, Null: true} }

func (n Nullable[T]) IsZero() bool { return !n.Set }

func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if n.Null {
		return []byte("null"), nil
	}
	return json.Marshal(n.Value)
}

func (n *Nullable[T]) UnmarshalJSON(data []byte) error {
	n.Set = true
	if isNull(data) {
		n.Null = true
		return nil
	}
	return json.Unmarshal(data, &n.Value)
}

// Error is a call that failed with an ARI call error.
type Error struct {
	CallError CallError
}

func (e *Error) Error() string {
	raw, _ := json.Marshal(e.CallError)
	var fields struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &fields)
	return fields.Code + ": " + fields.Message
}

// Code is the call error's code, such as "unsupported" or "transport".
func (e *Error) Code() string { return tagOf(mustJSON(e.CallError), "code") }

func Unsupported(capability, message string) *Error {
	return &Error{CallError{&UnsupportedError{Message: capability + ": " + message, Capability: capability}}}
}

func Validation(message string) *Error {
	return &Error{CallError{&ValidationError{Message: message}}}
}

func Protocol(detail, message string) *Error {
	return &Error{CallError{&ProtocolError{Message: message, Detail: detail}}}
}

func Transport(message string) *Error {
	return &Error{CallError{&TransportError{Message: message}}}
}

func invalidParams(err error) error { return Validation(err.Error()) }

// Client is one connection to an ARI driver.
type Client struct {
	writeMu sync.Mutex
	writer  io.WriteCloser
	cmd     *exec.Cmd
	host    Host

	mu             sync.Mutex
	nextID         int64
	nextHostStream int64
	pending        map[int64]*pending
	streams        map[string]*streamQueue
	refused        map[string]bool
	closed         *Error
	done           chan struct{}
}

type answer struct {
	result json.RawMessage
	err    error
}

type pending struct {
	answer chan answer
	stream *streamQueue
}

// Start runs cmd (an ari-driver <driver> invocation, such as the standalone executable) and
// connects to it over its stdin and stdout. Set cmd.Env and cmd.Dir first.
func Start(cmd *exec.Cmd, host Host) (*Client, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, Transport(err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, Transport(err.Error())
	}
	if err := cmd.Start(); err != nil {
		return nil, Transport("could not start ari-driver: " + err.Error())
	}
	client := Connect(stdout, stdin, host)
	client.cmd = cmd
	return client, nil
}

// Connect speaks to a driver over any byte streams: reader carries its frames, writer takes ours.
func Connect(reader io.Reader, writer io.WriteCloser, host Host) *Client {
	client := &Client{writer: writer, host: host, nextID: 1, nextHostStream: 1, pending: map[int64]*pending{}, streams: map[string]*streamQueue{}, refused: map[string]bool{}, done: make(chan struct{})}
	go client.readLoop(reader)
	return client
}

// Initialize is the handshake. It offers every method of methods.json at its version and no
// process delegation: the driver spawns its agents itself, with envPolicy applied. Methods whose
// major version differs, or that the driver does not list, are refused locally afterwards.
func (c *Client) Initialize(ctx context.Context, envPolicy EnvPolicy) (InitializeResult, error) {
	params := InitializeParams{AriVersion: AriVersion, GrammarVersions: VersionRange{1, 1}, MethodVersions: WireMethodVersions, PersistenceVersion: Version{Major: 1, Minor: 0}, Host: InitializeParamsHost{Capabilities: HostCapabilities{Process: false}, EnvPolicy: &envPolicy}}
	var result InitializeResult
	if err := c.call(ctx, "initialize", params, &result); err != nil {
		return result, err
	}
	if strings.Split(result.AriVersion, ".")[0] != strings.Split(AriVersion, ".")[0] {
		return result, Protocol("ari_version_mismatch", "the driver speaks ARI "+result.AriVersion+", this client "+AriVersion)
	}
	if result.GrammarVersion != 1 {
		return result, Protocol("grammar_version_mismatch", fmt.Sprintf("the driver chose grammar version %d, this client reads 1", result.GrammarVersion))
	}
	refused := map[string]bool{}
	for name, ours := range WireMethodVersions {
		theirs, listed := result.MethodVersions[name]
		if listed && theirs.Major == ours.Major {
			continue
		}
		for _, core := range coreMethods {
			if name == core {
				return result, Protocol("core_method_missing", fmt.Sprintf("the driver does not speak %s at major version %d", name, ours.Major))
			}
		}
		refused[name] = true
	}
	c.mu.Lock()
	c.refused = refused
	c.mu.Unlock()
	return result, nil
}

// Close closes our side, waits up to ten seconds for ari-driver to exit, then kills it.
func (c *Client) Close() error {
	c.writeMu.Lock()
	err := c.writer.Close()
	c.writeMu.Unlock()
	if c.cmd == nil {
		return err
	}
	// ari-driver exits once its stdin closes, which ends its output; Wait only after the reader is done.
	select {
	case <-c.done:
	case <-time.After(10 * time.Second):
		_ = c.cmd.Process.Kill()
		<-c.done
	}
	_ = c.cmd.Wait()
	return nil
}

func (c *Client) call(ctx context.Context, method string, params any, result any) error {
	raw, err := c.request(ctx, method, params, nil)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, result); err != nil {
		return Protocol("invalid_result", method+" answered something this client cannot read: "+err.Error())
	}
	return nil
}

func (c *Client) request(ctx context.Context, method string, params any, stream *streamQueue) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed != nil {
		c.mu.Unlock()
		return nil, c.closed
	}
	if c.refused[method] {
		c.mu.Unlock()
		return nil, Unsupported(method, "the handshake refused this method")
	}
	id := c.nextID
	c.nextID++
	waiting := &pending{answer: make(chan answer, 1), stream: stream}
	c.pending[id] = waiting
	c.mu.Unlock()
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		c.forget(id)
		return nil, err
	}
	select {
	case got := <-waiting.answer:
		return got.result, got.err
	case <-ctx.Done():
		c.forget(id)
		return nil, ctx.Err()
	}
}

func (c *Client) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) write(frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return Validation(err.Error())
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.writer.Write(append(data, '\n')); err != nil {
		return Transport("could not write to ari-driver: " + err.Error())
	}
	return nil
}

func (c *Client) readLoop(reader io.Reader) {
	defer close(c.done)
	buffered := bufio.NewReaderSize(reader, 1<<16)
	for {
		line, err := buffered.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			var frame map[string]json.RawMessage
			// A line that is not JSON is the driver's mistake; the connection goes on.
			if json.Unmarshal(line, &frame) == nil {
				c.handle(frame)
			}
		}
		if err != nil {
			break
		}
	}
	c.shutdown(Transport("the ari-driver process closed its output"))
}

func (c *Client) handle(frame map[string]json.RawMessage) {
	var method string
	_ = json.Unmarshal(frame["method"], &method)
	params := frame["params"]
	id, hasID := frame["id"]
	hasID = hasID && !isNull(id)
	switch {
	case method != "" && hasID:
		go c.answer(id, method, params)
	case method != "":
		c.notification(method, params)
	case hasID:
		number, err := strconv.ParseInt(string(id), 10, 64)
		if err == nil {
			c.response(number, frame)
		}
	}
}

func (c *Client) response(id int64, frame map[string]json.RawMessage) {
	c.mu.Lock()
	waiting, found := c.pending[id]
	delete(c.pending, id)
	if !found {
		c.mu.Unlock()
		return
	}
	if raw, failed := frame["error"]; failed {
		c.mu.Unlock()
		waiting.answer <- answer{err: callErrorOf(raw)}
		return
	}
	result := frame["result"]
	if waiting.stream != nil {
		if streamID := tagOf(result, "streamId"); streamID != "" {
			c.streams[streamID] = waiting.stream
		}
	}
	c.mu.Unlock()
	waiting.answer <- answer{result: result}
}

func (c *Client) notification(method string, params json.RawMessage) {
	streamID := tagOf(params, "streamId")
	c.mu.Lock()
	queue, found := c.streams[streamID]
	if method == "stream/end" {
		delete(c.streams, streamID)
	}
	c.mu.Unlock()
	if !found {
		return // an item for a stream we do not know is dropped
	}
	if method != "stream/end" {
		queue.push(params, nil)
		return
	}
	var end struct {
		Error *CallError `json:"error"`
	}
	_ = json.Unmarshal(params, &end)
	if end.Error != nil {
		queue.end(&Error{*end.Error})
	} else {
		queue.end(nil)
	}
}

func (c *Client) answer(id json.RawMessage, method string, params json.RawMessage) {
	watch := method == "host/config.get" && tagOf(params, "watch") == "true"
	var result any
	var failure error
	code := callErrorCode
	switch {
	case method == "stream/cancel":
		result = nil // this client starts no streams the driver could cancel: a config watch ends at once
	case !hostMethods[method]:
		code, failure = methodNotFound, Unsupported(method, "no such host method")
	default:
		result, failure = dispatchHost(context.Background(), c.host, method, params)
	}
	var frame map[string]any
	endStream := ""
	if failure == nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			failure = Protocol("unserializable_result", err.Error())
		} else if watch && tagOf(encoded, "streamId") == "" {
			// A host with nothing to watch still starts the stream and ends it at once.
			c.mu.Lock()
			endStream = fmt.Sprintf("host-config-%d", c.nextHostStream)
			c.nextHostStream++
			c.mu.Unlock()
			var fields map[string]any
			_ = json.Unmarshal(encoded, &fields)
			fields["streamId"] = endStream
			result = fields
		}
	}
	if failure == nil {
		frame = map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
	} else {
		var callError *Error
		if !errors.As(failure, &callError) {
			code, callError = -32603, Protocol("uncaught_error", failure.Error())
		} else if callError.Code() == "validation" && code == callErrorCode {
			code = invalidParamsCode
		}
		frame = map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": callError.Error(), "data": callError.CallError}}
	}
	if c.write(frame) == nil && endStream != "" {
		_ = c.write(map[string]any{"jsonrpc": "2.0", "method": "stream/end", "params": map[string]any{"streamId": endStream}})
	}
}

func (c *Client) shutdown(err *Error) {
	c.mu.Lock()
	c.closed = err
	waiting := c.pending
	streams := c.streams
	c.pending = map[int64]*pending{}
	c.streams = map[string]*streamQueue{}
	c.mu.Unlock()
	for _, entry := range waiting {
		entry.answer <- answer{err: err}
	}
	for _, queue := range streams {
		queue.end(err)
	}
}

// callErrorOf is the call error in a JSON-RPC error: its data when that is one, else one made from the code.
func callErrorOf(raw json.RawMessage) *Error {
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	_ = json.Unmarshal(raw, &envelope)
	if tagOf(envelope.Data, "code") != "" {
		var callError CallError
		if json.Unmarshal(envelope.Data, &callError) == nil {
			return &Error{callError}
		}
	}
	switch envelope.Code {
	case methodNotFound:
		return Unsupported("unknown", envelope.Message)
	case invalidParamsCode:
		return Validation(envelope.Message)
	}
	return Protocol("jsonrpc_error", envelope.Message)
}

// Stream is one stream's items, in order, on the typed channel C. C closes after the driver's
// stream/end; Err then says whether the stream failed.
type Stream[T any] struct {
	C        <-chan T
	StreamID string
	client   *Client
	queue    *streamQueue
}

// Err is the stream's failure, once C is closed: nil when it ended normally.
func (s *Stream[T]) Err() error {
	s.queue.mu.Lock()
	defer s.queue.mu.Unlock()
	if s.queue.err == nil {
		return nil
	}
	return s.queue.err
}

// Cancel asks the driver to stop the stream; it then sends stream/end.
func (s *Stream[T]) Cancel(ctx context.Context) error {
	return s.client.call(ctx, "stream/cancel", StreamCancelParams{StreamID: s.StreamID}, &Null{})
}

// streamQueue holds a stream's items until the consumer takes them, so a slow consumer never
// blocks the reader.
type streamQueue struct {
	mu     sync.Mutex
	items  []json.RawMessage
	ended  bool
	err    *Error
	signal chan struct{}
}

func newStreamQueue() *streamQueue { return &streamQueue{signal: make(chan struct{}, 1)} }

func (q *streamQueue) push(item json.RawMessage, _ *Error) {
	q.mu.Lock()
	q.items = append(q.items, item)
	q.mu.Unlock()
	q.wake()
}

func (q *streamQueue) end(err *Error) {
	q.mu.Lock()
	if !q.ended {
		q.ended, q.err = true, err
	}
	q.mu.Unlock()
	q.wake()
}

func (q *streamQueue) wake() {
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func subscribe[T any](ctx context.Context, c *Client, method string, params any, itemField string) (*Stream[T], error) {
	queue := newStreamQueue()
	raw, err := c.request(ctx, method, params, queue)
	if err != nil {
		return nil, err
	}
	items := make(chan T)
	stream := &Stream[T]{C: items, StreamID: tagOf(raw, "streamId"), client: c, queue: queue}
	go func() {
		defer close(items)
		for {
			queue.mu.Lock()
			next, ended := queue.items, queue.ended
			queue.items = nil
			queue.mu.Unlock()
			for _, params := range next {
				var fields map[string]json.RawMessage
				var item T
				if json.Unmarshal(params, &fields) == nil && json.Unmarshal(fields[itemField], &item) == nil {
					items <- item
					continue
				}
				queue.end(Protocol("invalid_stream_item", "a stream item this client cannot read: "+string(params)))
				return
			}
			if ended && len(next) == 0 {
				return
			}
			if len(next) == 0 {
				<-queue.signal
			}
		}
	}()
	return stream, nil
}

// tagOf is the string field name of a JSON object, or "" (true and false as "true" and "false").
func tagOf(data json.RawMessage, name string) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return ""
	}
	var text string
	if json.Unmarshal(fields[name], &text) == nil {
		return text
	}
	var flag bool
	if json.Unmarshal(fields[name], &flag) == nil {
		return strconv.FormatBool(flag)
	}
	return ""
}

func isNull(data []byte) bool { return string(bytes.TrimSpace(data)) == "null" }

// hasFields reports whether the JSON object data has every named field.
func hasFields(data []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return false
	}
	for _, name := range names {
		if _, found := fields[name]; !found {
			return false
		}
	}
	return true
}

func mustJSON(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}
