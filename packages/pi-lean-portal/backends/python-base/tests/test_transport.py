"""
Tests for pi_browser_bridge.transport — JSON-RPC 2.0 I/O helpers.

Tests use ``io.StringIO`` to mock stdin/stdout for the I/O functions,
while the response builder functions are pure and tested directly.
"""


import io
import json
import sys

import pytest

from pi_browser_bridge.transport import (
    read_request,
    write_response,
    make_success_response,
    make_error_response,
    make_parse_error,
    make_invalid_request,
    make_internal_error,
    make_application_error,
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    INTERNAL_ERROR,
    APPLICATION_ERROR,
    TIMEOUT_ERROR,
    SESSION_ERROR,
)


# ═════════════════════════════════════════════════════════════════════
#  Response builders (pure functions, no I/O)
# ═════════════════════════════════════════════════════════════════════


class TestMakeSuccessResponse:
    def test_with_string_result(self) -> None:
        resp = make_success_response(1, "pong")
        assert resp == {"jsonrpc": "2.0", "id": 1, "result": "pong"}

    def test_with_dict_result(self) -> None:
        resp = make_success_response(2, {"success": True})
        assert resp["result"] == {"success": True}
        assert resp["id"] == 2

    def test_null_id(self) -> None:
        resp = make_success_response(None, "ok")
        assert resp["id"] is None


class TestMakeErrorResponse:
    def test_basic_error(self) -> None:
        resp = make_error_response(1, -32000, "Something went wrong")
        assert resp["error"]["code"] == -32000
        assert resp["error"]["message"] == "Something went wrong"
        assert "data" not in resp["error"]

    def test_with_data(self) -> None:
        resp = make_error_response(1, -32000, "fail", data={"traceback": "..."})
        assert resp["error"]["data"] == {"traceback": "..."}

    def test_none_id(self) -> None:
        resp = make_error_response(None, -32700, "Parse error")
        assert resp["id"] is None


class TestMakeParseError:
    def test_default_id(self) -> None:
        resp = make_parse_error()
        assert resp["error"]["code"] == PARSE_ERROR
        assert resp["id"] is None

    def test_custom_id(self) -> None:
        resp = make_parse_error(42)
        assert resp["id"] == 42


class TestMakeInvalidRequest:
    def test_code(self) -> None:
        resp = make_invalid_request()
        assert resp["error"]["code"] == INVALID_REQUEST

    def test_message(self) -> None:
        resp = make_invalid_request(99)
        assert "Invalid Request" in resp["error"]["message"]


class TestMakeInternalError:
    def test_includes_traceback(self) -> None:
        try:
            raise RuntimeError("test error")
        except RuntimeError as exc:
            resp = make_internal_error(1, exc)

        assert resp["error"]["code"] == INTERNAL_ERROR
        assert "test error" in resp["error"]["message"]
        assert "traceback" in resp["error"]["data"]
        assert "RuntimeError" in resp["error"]["data"]["traceback"]


class TestMakeApplicationError:
    def test_basic(self) -> None:
        resp = make_application_error(1, "app error")
        assert resp["error"]["code"] == APPLICATION_ERROR
        assert resp["id"] == 1
        # Without traceback, data should be None
        assert resp["error"].get("data") is None

    def test_with_traceback(self) -> None:
        resp = make_application_error(2, "fail", traceback_str="Traceback ...")
        assert resp["error"]["data"]["traceback"] == "Traceback ..."

    def test_none_id(self) -> None:
        resp = make_application_error(None, "no-id error")
        assert resp["id"] is None


# ═════════════════════════════════════════════════════════════════════
#  Error code constants
# ═════════════════════════════════════════════════════════════════════


class TestErrorCodes:
    def test_standard_codes(self) -> None:
        assert PARSE_ERROR == -32700
        assert INVALID_REQUEST == -32600
        assert METHOD_NOT_FOUND == -32601
        assert INVALID_PARAMS == -32602
        assert INTERNAL_ERROR == -32603

    def test_custom_codes(self) -> None:
        assert APPLICATION_ERROR == -32000
        assert TIMEOUT_ERROR == -32001
        assert SESSION_ERROR == -32002

    def test_no_overlap(self) -> None:
        standard = {PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND,
                    INVALID_PARAMS, INTERNAL_ERROR}
        custom = {APPLICATION_ERROR, TIMEOUT_ERROR, SESSION_ERROR}
        assert standard.isdisjoint(custom)


# ═════════════════════════════════════════════════════════════════════
#  read_request — I/O via monkeypatched sys.stdin
# ═════════════════════════════════════════════════════════════════════


class TestReadRequest:
    def test_valid_request(self, monkeypatch: pytest.MonkeyPatch) -> None:
        request = {"jsonrpc": "2.0", "method": "ping", "id": 1}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request) + "\n"))
        result = read_request()
        assert result == request

    def test_eof_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO(""))
        assert read_request() is None

    def test_empty_line_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
        assert read_request() is None

    def test_multiple_whitespace_lines_skipped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("  \n\n    \n"))
        # All whitespace lines should return None (treated as heartbeat)
        assert read_request() is None

    def test_invalid_json_raises_value_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("not json\n"))
        with pytest.raises(ValueError, match="Failed to parse"):
            read_request()

    def test_missing_jsonrpc_field(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = {"method": "ping", "id": 1}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request) + "\n"))
        with pytest.raises(ValueError, match='jsonrpc.*"2.0"'):
            read_request()

    def test_wrong_jsonrpc_version(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = {"jsonrpc": "1.0", "method": "ping", "id": 1}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request) + "\n"))
        with pytest.raises(ValueError, match='jsonrpc.*"2.0"'):
            read_request()

    def test_missing_method(self, monkeypatch: pytest.MonkeyPatch) -> None:
        request = {"jsonrpc": "2.0", "id": 1}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request) + "\n"))
        with pytest.raises(ValueError, match="method"):
            read_request()

    def test_non_string_method(self, monkeypatch: pytest.MonkeyPatch) -> None:
        request = {"jsonrpc": "2.0", "method": 42, "id": 1}
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request) + "\n"))
        with pytest.raises(ValueError, match="method"):
            read_request()

    def test_non_dict_json(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO('"just a string"\n'))
        with pytest.raises(ValueError, match="JSON object"):
            read_request()

    def test_works_after_whitespace_line(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = {"jsonrpc": "2.0", "method": "browser.navigate", "id": 2}
        monkeypatch.setattr(
            "sys.stdin",
            io.StringIO("\n\n" + json.dumps(request) + "\n"),
        )
        result = read_request()
        assert result is not None
        assert result["method"] == "browser.navigate"


# ═════════════════════════════════════════════════════════════════════
#  write_response — I/O via monkeypatched sys.stdout
# ═════════════════════════════════════════════════════════════════════


class TestWriteResponse:
    def test_writes_json_line_and_flushes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        output = io.StringIO()
        monkeypatch.setattr("sys.stdout", output)

        response = {"jsonrpc": "2.0", "result": "pong", "id": 1}
        write_response(response)

        written = output.getvalue()
        assert written == '{"jsonrpc": "2.0", "result": "pong", "id": 1}\n'

    def test_error_response(self, monkeypatch: pytest.MonkeyPatch) -> None:
        output = io.StringIO()
        monkeypatch.setattr("sys.stdout", output)

        response = make_error_response(1, -32000, "fail")
        write_response(response)

        written = json.loads(output.getvalue())
        assert written["error"]["code"] == -32000
        assert written["error"]["message"] == "fail"


# ═════════════════════════════════════════════════════════════════════
#  Integration: roundtrip
# ═════════════════════════════════════════════════════════════════════


class TestRoundtrip:
    def test_success_roundtrip(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Write a request, read it back, validate roundtrip."""
        request = {"jsonrpc": "2.0", "method": "ping", "params": {}, "id": 1}
        monkeypatch.setattr(
            "sys.stdin",
            io.StringIO(json.dumps(request) + "\n"),
        )

        read = read_request()
        assert read == request

    def test_response_roundtrip(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Read a request, build a response, write it."""
        request = {"jsonrpc": "2.0", "method": "ping", "id": 5}
        monkeypatch.setattr(
            "sys.stdin",
            io.StringIO(json.dumps(request) + "\n"),
        )

        read = read_request()
        assert read is not None

        response = make_success_response(read["id"], "pong")

        output = io.StringIO()
        monkeypatch.setattr("sys.stdout", output)
        write_response(response)

        parsed = json.loads(output.getvalue())
        assert parsed["result"] == "pong"
        assert parsed["id"] == 5
