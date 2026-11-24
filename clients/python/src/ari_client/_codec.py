"""Decoding and encoding helpers the generated models use, and the call error exception."""

from __future__ import annotations

import enum
from typing import Any, Callable, TypeVar

T = TypeVar("T")
Decoder = Callable[[Any], T]


class WireDecodeError(ValueError):
    """A frame does not have the shape the wire types say."""


class Unset:
    """The type of `UNSET`: an optional field that may be null was absent."""

    _instance: Unset | None = None

    def __new__(cls) -> Unset:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = Unset()
"""An optional field that may also be null was absent: `None` is a JSON null, `UNSET` is no field."""


class OpenEnum(str, enum.Enum):
    """A string enum that keeps a value it does not know instead of refusing it."""

    @classmethod
    def _missing_(cls, value: object) -> Any:
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNRECOGNIZED"
        member._value_ = value
        return member

    @property
    def recognized(self) -> bool:
        """False for a value this client does not know."""
        return self._value_ in type(self)._value2member_map_

    @classmethod
    def from_json(cls, data: Any) -> Any:
        if not isinstance(data, str):
            raise WireDecodeError(f"{cls.__name__}: expected a string, got {data!r}")
        return cls(data)

    def __str__(self) -> str:
        return str(self._value_)


class AriCallError(Exception):
    """A call failed with an ARI call error. `error` is the `CallError` (one of the generated error classes)."""

    def __init__(self, error: Any) -> None:
        self.error = error
        raw = error.to_json() if hasattr(error, "to_json") else {}
        self.code: str = str(raw.get("code", "error"))
        super().__init__(f"{self.code}: {raw.get('message', '')}")


def require_object(data: Any, name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise WireDecodeError(f"{name}: expected an object, got {data!r}")
    return data


def required(data: dict[str, Any], key: str, decode: Decoder[T]) -> T:
    if key not in data:
        raise WireDecodeError(f"missing required field {key!r}")
    return decode(data[key])


def optional(data: dict[str, Any], key: str, decode: Decoder[T]) -> T | None:
    value = data.get(key)
    return None if value is None else decode(value)


def present(data: dict[str, Any], key: str, decode: Decoder[T]) -> T | Unset:
    return decode(data[key]) if key in data else UNSET


def decode_any(data: Any) -> Any:
    return data


def decode_null(data: Any) -> None:
    if data is not None:
        raise WireDecodeError(f"expected null, got {data!r}")
    return None


def decode_str(data: Any) -> str:
    if not isinstance(data, str):
        raise WireDecodeError(f"expected a string, got {data!r}")
    return data


def decode_int(data: Any) -> int:
    if isinstance(data, bool) or not isinstance(data, int):
        if isinstance(data, float) and data.is_integer():
            return int(data)
        raise WireDecodeError(f"expected an integer, got {data!r}")
    return data


def decode_float(data: Any) -> float:
    if isinstance(data, bool) or not isinstance(data, (int, float)):
        raise WireDecodeError(f"expected a number, got {data!r}")
    return float(data)


def decode_bool(data: Any) -> bool:
    if not isinstance(data, bool):
        raise WireDecodeError(f"expected a boolean, got {data!r}")
    return data


def list_of(decode: Decoder[T]) -> Decoder[list[T]]:
    def decode_list(data: Any) -> list[T]:
        if not isinstance(data, list):
            raise WireDecodeError(f"expected a list, got {data!r}")
        return [decode(item) for item in data]

    return decode_list


def tuple_of(*decoders: Decoder[Any]) -> Decoder[tuple[Any, ...]]:
    def decode_tuple(data: Any) -> tuple[Any, ...]:
        if not isinstance(data, list) or len(data) != len(decoders):
            raise WireDecodeError(f"expected a list of {len(decoders)}, got {data!r}")
        return tuple(decode(item) for decode, item in zip(decoders, data))

    return decode_tuple


def map_of(decode: Decoder[T]) -> Decoder[dict[str, T]]:
    def decode_map(data: Any) -> dict[str, T]:
        if not isinstance(data, dict):
            raise WireDecodeError(f"expected an object, got {data!r}")
        return {key: decode(value) for key, value in data.items()}

    return decode_map


def nullable(decode: Decoder[T]) -> Decoder[T | None]:
    return lambda data: None if data is None else decode(data)


def first_of(name: str, data: Any, *decoders: Decoder[Any]) -> Any:
    """The first decoder that accepts `data`, for a union without a discriminator."""
    for decode in decoders:
        try:
            return decode(data)
        except WireDecodeError:
            continue
    raise WireDecodeError(f"{name}: no variant accepts {data!r}")


def encode(value: Any) -> Any:
    """`value` as JSON data: models by their `to_json`, enums by their value."""
    if hasattr(value, "to_json"):
        return value.to_json()
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    return value


def unsupported(capability: str, message: str) -> Any:
    from ._generated import UnsupportedError

    return UnsupportedError(message=f"{capability}: {message}", capability=capability)


def validation(message: str) -> Any:
    from ._generated import ValidationError

    return ValidationError(message=message)


def protocol(detail: str, message: str) -> Any:
    from ._generated import ProtocolError

    return ProtocolError(message=message, detail=detail)


def transport(message: str) -> Any:
    from ._generated import TransportError

    return TransportError(message=message)
