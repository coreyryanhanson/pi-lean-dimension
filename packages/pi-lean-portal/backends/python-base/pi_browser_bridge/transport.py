"""
JSON-RPC 2.0 transport over stdin/stdout for the Python bridge.

Protocol:
- Each message is a single JSON-RPC 2.0 request or response, one per line.
- Requests use newline-delimited framing (each JSON object on one line).
- Responses are written to stdout as a single JSON line, then flushed.

Request format::

    {"jsonrpc":"2.0","method":"browser.navigate","params":{...},"id":1}

Success response::

    {"jsonrpc":"2.0","result":{...},"id":1}

Error response::

    {"jsonrpc":"2.0","error":{"code":-32000,"message":"...","data":{...}},"id":1}
"""

import json
import sys
import traceback
from typing import Any, Optional


# ─── Standard JSON-RPC error codes ────────────────────────────────────

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Custom error codes (application-level)
APPLICATION_ERROR = -32000
TIMEOUT_ERROR = -32001
SESSION_ERROR = -32002


# ─── Custom exceptions ────────────────────────────────────────────────


class InvalidRequestError(ValueError):
    """Raised when a request has valid JSON but is not a valid JSON-RPC
    Request object (e.g. missing ``jsonrpc`` or ``method`` fields).
    """


# ─── Reading requests ─────────────────────────────────────────────────

def read_request() -> Optional[dict[str, Any]]:
    """Read one JSON-RPC request from stdin (line-delimited).

    Returns the parsed request dict, or None on EOF.
    Raises ValueError on JSON parse failure.
    Raises InvalidRequestError on structural validation failure.
    """
    # Skip empty lines (heartbeats), stop at EOF
    while True:
        line = sys.stdin.readline()
        if not line:
            return None  # EOF
        line = line.strip()
        if line:
            break  # non-empty line found

    try:
        request: dict[str, Any] = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Failed to parse JSON-RPC request: {exc}") from exc

    # Validate basic JSON-RPC structure
    if not isinstance(request, dict):
        raise InvalidRequestError("JSON-RPC request must be a JSON object")

    if request.get("jsonrpc") != "2.0":
        raise InvalidRequestError('Missing or invalid "jsonrpc": "2.0" field')

    if "method" not in request or not isinstance(request.get("method"), str):
        raise InvalidRequestError('Missing or invalid "method" field')

    return request


# ─── Writing responses ────────────────────────────────────────────────

def write_response(response: dict[str, Any]) -> None:
    """Write a JSON-RPC response to stdout as a single JSON line, then flush.

    The response should already be a complete JSON-RPC response dict
    (with ``jsonrpc``, ``id``, and either ``result`` or ``error``).
    """
    line = json.dumps(response, ensure_ascii=False, default=str)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def make_success_response(request_id: Any, result: Any) -> dict[str, Any]:
    """Build a JSON-RPC success response."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result,
    }


def make_error_response(
    request_id: Any,
    code: int,
    message: str,
    data: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Build a JSON-RPC error response."""
    error: dict[str, Any] = {
        "code": code,
        "message": message,
    }
    if data is not None:
        error["data"] = data
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": error,
    }


def make_parse_error(request_id: Any = None) -> dict[str, Any]:
    """Build a JSON-RPC parse error response."""
    return make_error_response(request_id, PARSE_ERROR, "Parse error")


def make_invalid_request(request_id: Any = None) -> dict[str, Any]:
    """Build a JSON-RPC invalid request response."""
    return make_error_response(request_id, INVALID_REQUEST, "Invalid Request")


def make_internal_error(
    request_id: Any,
    exc: Exception,
) -> dict[str, Any]:
    """Build an internal error response including Python traceback."""
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
    return make_error_response(
        request_id,
        INTERNAL_ERROR,
        f"Internal error: {exc}",
        data={"traceback": "".join(tb)},
    )


def make_application_error(
    request_id: Any,
    message: str,
    traceback_str: Optional[str] = None,
) -> dict[str, Any]:
    """Build an application-level error response."""
    data: dict[str, Any] = {}
    if traceback_str:
        data["traceback"] = traceback_str
    return make_error_response(
        request_id,
        APPLICATION_ERROR,
        message,
        data=data or None,
    )
