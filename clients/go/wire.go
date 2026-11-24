package ari

// Types and helpers the generated code and the framing share: JSON null, optional fields that may
// be null, call errors as Go errors, and reading one field of a raw JSON object.

import (
	"bytes"
	"encoding/json"
	"strconv"
)

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
