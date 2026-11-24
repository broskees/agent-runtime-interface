// Framing rules and forward compatibility, against a scripted driver on in-memory pipes: events of a
// type this client does not know (x:vendor.ping, and session.hibernated from a newer ARI) reach the
// UnrecognizedAriEventBody catch-all with their raw JSON instead of failing the stream; the client
// answers the driver's host/* requests while its own call is pending; items sent in the same buffer
// as the response that starts their stream are not lost; and a driver that goes away fails the
// pending call with transport.

package ari

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

type scriptedDriver struct {
	t      *testing.T
	lines  *bufio.Reader
	writer io.WriteCloser
}

func (d *scriptedDriver) read() map[string]any {
	d.t.Helper()
	type result struct {
		line []byte
		err  error
	}
	got := make(chan result, 1)
	go func() {
		line, err := d.lines.ReadBytes('\n')
		got <- result{line, err}
	}()
	select {
	case read := <-got:
		if read.err != nil {
			d.t.Fatal("reading a frame:", read.err)
		}
		var frame map[string]any
		if err := json.Unmarshal(read.line, &frame); err != nil {
			d.t.Fatal(err)
		}
		return frame
	case <-time.After(5 * time.Second):
		d.t.Fatal("no frame within 5 s")
		return nil
	}
}

// write sends all frames in one write, so the client reads them from one buffer.
func (d *scriptedDriver) write(frames ...any) {
	d.t.Helper()
	var text strings.Builder
	for _, frame := range frames {
		data, err := json.Marshal(frame)
		if err != nil {
			d.t.Fatal(err)
		}
		text.Write(data)
		text.WriteByte('\n')
	}
	go func() { _, _ = io.WriteString(d.writer, text.String()) }()
}

func connectScripted(t *testing.T, host Host) (*Client, *scriptedDriver) {
	clientReads, driverWrites := io.Pipe()
	driverReads, clientWrites := io.Pipe()
	client := Connect(clientReads, clientWrites, host)
	return client, &scriptedDriver{t: t, lines: bufio.NewReader(driverReads), writer: driverWrites}
}

func handshakeResult() map[string]any {
	return map[string]any{
		"ariVersion": AriVersion, "grammarVersions": []int{1, 1}, "methodVersions": WireMethodVersions, "persistenceVersion": map[string]int{"major": 1, "minor": 0},
		"grammarVersion": 1,
		"driver":         map[string]any{"kind": "scripted", "ariVersion": AriVersion, "metadata": map[string]any{"displayName": "Scripted", "multipleInstances": false, "hasDefaultInstance": false}, "configSchema": true},
	}
}

func initialized(t *testing.T, host Host) (*Client, *scriptedDriver) {
	client, driver := connectScripted(t, host)
	done := make(chan error, 1)
	go func() {
		_, err := client.Initialize(context.Background(), EnvPolicy{StripAmbient: []string{"SECRET_*"}})
		done <- err
	}()
	initialize := driver.read()
	if initialize["method"] != "initialize" {
		t.Fatalf("first frame: %v", initialize)
	}
	params := initialize["params"].(map[string]any)
	if !reflect.DeepEqual(params["host"], map[string]any{"capabilities": map[string]any{"process": false}, "envPolicy": map[string]any{"stripAmbient": []any{"SECRET_*"}}}) {
		t.Fatalf("host: %v", params["host"])
	}
	if !reflect.DeepEqual(params["methodVersions"].(map[string]any)["session/startTurn"], map[string]any{"major": 1.0, "minor": 0.0}) {
		t.Fatalf("methodVersions: %v", params["methodVersions"])
	}
	driver.write(map[string]any{"jsonrpc": "2.0", "id": initialize["id"], "result": handshakeResult()})
	if err := <-done; err != nil {
		t.Fatal("initialize:", err)
	}
	return client, driver
}

func TestUnknownEventTypesReachTheCatchAllAndKnownOnesStillDecode(t *testing.T) {
	client, driver := initialized(t, NewMemoryHost())
	type subscribed struct {
		stream *Stream[AriEvent]
		err    error
	}
	got := make(chan subscribed, 1)
	go func() {
		stream, err := client.SessionEvents(context.Background(), SessionEventsParams{SessionID: "s-1"})
		got <- subscribed{stream, err}
	}()
	request := driver.read()
	if request["method"] != "session/events" {
		t.Fatalf("request: %v", request)
	}
	ping := `{"type":"x:vendor.ping","data":{"n":1},"fallback":{"title":"Ping"}}`
	hibernated := `{"type":"session.hibernated","until":"tomorrow"}`
	event := func(seq int, body string) map[string]any {
		return map[string]any{"jsonrpc": "2.0", "method": "ari/event", "params": map[string]any{"streamId": "d1", "event": map[string]any{"seq": seq, "at": "2026-11-23T00:00:00.000Z", "sessionId": "s-1", "body": json.RawMessage(body)}}}
	}
	driver.write(
		map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"streamId": "d1"}},
		event(1, ping),
		event(2, hibernated),
		event(3, `{"type":"turn.terminal","turnId":"t-1","status":"paused","threadDisposition":"reusable"}`),
		map[string]any{"jsonrpc": "2.0", "method": "stream/end", "params": map[string]any{"streamId": "d1"}},
	)
	result := <-got
	if result.err != nil {
		t.Fatal("session/events:", result.err)
	}
	var events []AriEvent
	for event := range result.stream.C {
		events = append(events, event)
	}
	if err := result.stream.Err(); err != nil {
		t.Fatal("the stream failed:", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events", len(events))
	}
	first, ok := events[0].Body.Value.(*UnrecognizedAriEventBody)
	if !ok || first.Tag() != "x:vendor.ping" || string(first.Raw) != ping {
		t.Fatalf("x:vendor.ping should reach the catch-all, got %#v", events[0].Body.Value)
	}
	second, ok := events[1].Body.Value.(*UnrecognizedAriEventBody)
	if !ok || string(second.Raw) != hibernated {
		t.Fatalf("session.hibernated should reach the catch-all, got %#v", events[1].Body.Value)
	}
	terminal, ok := events[2].Body.Value.(*TurnTerminalBody)
	if !ok {
		t.Fatalf("turn.terminal decodes as its own variant, got %#v", events[2].Body.Value)
	}
	// An unknown enum value is kept too.
	if terminal.Status != "paused" || terminal.Status.Recognized() {
		t.Fatalf("status: %q", terminal.Status)
	}
	// And everything goes back on the wire as it came.
	again, _ := json.Marshal(events[0].Body)
	if string(again) != ping {
		t.Fatalf("re-encoded: %s", again)
	}
	encoded, _ := json.Marshal(events[2].Body)
	if !strings.Contains(string(encoded), `"status":"paused"`) || !strings.Contains(string(encoded), `"type":"turn.terminal"`) {
		t.Fatalf("re-encoded: %s", encoded)
	}
}

func TestTheHostAnswersTheDriverWhileACallIsPending(t *testing.T) {
	host := NewMemoryHost().WithConfig("i-1", map[string]any{"binary": "x"})
	client, driver := initialized(t, host)
	done := make(chan error, 1)
	go func() {
		probe, err := client.InstanceProbe(context.Background(), InstanceProbeParams{InstanceID: "i-1"})
		if err == nil && !probe.Installed {
			err = errors.New("probe says not installed")
		}
		done <- err
	}()
	probe := driver.read()
	if probe["method"] != "instance/probe" {
		t.Fatalf("request: %v", probe)
	}
	// Before answering, the driver asks the host for four things.
	driver.write(
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "host/config.get", "params": map[string]any{"instanceId": "i-1", "watch": true}},
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "host/secrets.get", "params": map[string]any{"instanceId": "i-1", "namespace": "n", "key": "k"}},
		map[string]any{"jsonrpc": "2.0", "id": 3, "method": "host/process.spawn", "params": map[string]any{"instanceId": "i-1", "processId": "p1", "command": "x", "purpose": "probe"}},
		map[string]any{"jsonrpc": "2.0", "id": 4, "method": "host/diagnostics.log", "params": map[string]any{"instanceId": "i-1", "level": "warn", "msg": "hello"}},
	)
	answers := map[float64]map[string]any{}
	configStreamEnd := ""
	for len(answers) < 4 || configStreamEnd == "" {
		frame := driver.read()
		if frame["method"] == "stream/end" {
			configStreamEnd = frame["params"].(map[string]any)["streamId"].(string)
		} else {
			answers[frame["id"].(float64)] = frame
		}
	}
	config := answers[1]["result"].(map[string]any)
	if !reflect.DeepEqual(config["config"], map[string]any{"binary": "x"}) {
		t.Fatalf("config: %v", config)
	}
	// A watch is answered with a stream that ends at once.
	if config["streamId"] != configStreamEnd {
		t.Fatalf("watch stream %v, ended %v", config["streamId"], configStreamEnd)
	}
	if answers[2]["result"] != nil {
		t.Fatalf("secrets.get: %v", answers[2])
	}
	if answers[3]["error"].(map[string]any)["data"].(map[string]any)["code"] != "unsupported" {
		t.Fatalf("process.spawn: %v", answers[3])
	}
	if answers[4]["result"] != nil || len(host.Diagnostics()) != 1 || host.Diagnostics()[0].Msg != "hello" {
		t.Fatalf("diagnostics.log: %v %+v", answers[4], host.Diagnostics())
	}
	driver.write(map[string]any{"jsonrpc": "2.0", "id": probe["id"], "result": map[string]any{"ok": true, "installed": true, "checkedAt": "2026-11-23T00:00:00.000Z"}})
	if err := <-done; err != nil {
		t.Fatal("instance/probe:", err)
	}
}

func TestADriverThatGoesAwayFailsPendingCallsWithTransport(t *testing.T) {
	client, driver := initialized(t, NewMemoryHost())
	done := make(chan error, 1)
	go func() {
		_, err := client.InstanceStatus(context.Background(), InstanceTarget{InstanceID: "i-1"})
		done <- err
	}()
	if request := driver.read(); request["method"] != "instance/status" {
		t.Fatalf("request: %v", request)
	}
	driver.writer.Close()
	var failure *Error
	if err := <-done; !errors.As(err, &failure) || failure.Code() != "transport" {
		t.Fatalf("pending call: %v", err)
	}
	_, err := client.InstanceStatus(context.Background(), InstanceTarget{InstanceID: "i-1"})
	if !errors.As(err, &failure) || failure.Code() != "transport" {
		t.Fatalf("later call: %v", err)
	}
}

func TestCallErrorsAndUnknownCodesRoundTrip(t *testing.T) {
	var unsupported CallError
	if err := json.Unmarshal([]byte(`{"code":"unsupported","message":"no","capability":"threads.fork"}`), &unsupported); err != nil {
		t.Fatal(err)
	}
	if value, ok := unsupported.Value.(*UnsupportedError); !ok || value.Capability != "threads.fork" {
		t.Fatalf("%#v", unsupported.Value)
	}
	extension := `{"code":"x:vendor.quota","message":"slow down","detail":3}`
	var decoded CallError
	if err := json.Unmarshal([]byte(extension), &decoded); err != nil {
		t.Fatal(err)
	}
	if value, ok := decoded.Value.(*UnrecognizedCallError); !ok || string(value.Raw) != extension {
		t.Fatalf("%#v", decoded.Value)
	}
	again, _ := json.Marshal(decoded)
	if string(again) != extension {
		t.Fatalf("re-encoded: %s", again)
	}
}
