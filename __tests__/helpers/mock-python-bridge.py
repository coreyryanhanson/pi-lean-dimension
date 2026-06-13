#!/usr/bin/env python3
"""Mock bridge for testing PythonPluginAdapter.

Reads JSON-RPC 2.0 requests from stdin and writes hardcoded responses
to stdout.  Supports: ping, shutdown, browser.navigate, browser.snapshot,
browser.click, browser.cleanup.  Unknown methods return a METHOD_NOT_FOUND
error.  The string "INVALID_JSON" as a request line triggers a malformed
JSON response (to test protocol violation handling).
"""
import json
import sys


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        # Special case: protocol violation test
        if line == "INVALID_JSON":
            sys.stdout.write("not valid json\n")
            sys.stdout.flush()
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            write_response(None, error={"code": -32700, "message": "Parse error"})
            continue

        method = request.get("method", "")
        params = request.get("params", {})
        req_id = request.get("id")

        if method == "ping":
            write_response(req_id, result="pong")

        elif method == "shutdown":
            write_response(req_id, result="shutting_down")
            sys.stdout.flush()
            break

        elif method == "browser.navigate":
            write_response(
                req_id,
                result={
                    "success": True,
                    "url": params.get("url", ""),
                    "title": params.get("title", "Mock Page"),
                    "snapshot": "- @e1 [link] Example Domain\n- @e2 [button] Submit",
                    "elementCount": 2,
                    "botDetected": False,
                    "elements": {
                        "e1": {
                            "role": "link",
                            "name": "Example Domain",
                            "props": [],
                            "depth": 0,
                            "raw": "- link \"Example Domain\"",
                            "occurrenceIndex": 0,
                        },
                        "e2": {
                            "role": "button",
                            "name": "Submit",
                            "props": [],
                            "depth": 0,
                            "raw": "- button \"Submit\"",
                            "occurrenceIndex": 0,
                        },
                    },
                },
            )

        elif method == "browser.snapshot":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [link] Example",
                    "elementCount": 1,
                    "elements": {
                        "e1": {
                            "role": "link",
                            "name": "Example",
                            "props": [],
                            "depth": 0,
                            "raw": "- link \"Example\"",
                            "occurrenceIndex": 0,
                        },
                    },
                },
            )

        elif method == "browser.click":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [link] Clicked",
                    "elementCount": 1,
                    "newUrl": "https://example.com/clicked",
                    "newTitle": "Clicked",
                },
            )

        elif method == "browser.type":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [textbox] mock value",
                    "elementCount": 1,
                },
            )

        elif method == "browser.scroll":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [link] Scrolled",
                    "elementCount": 1,
                },
            )

        elif method == "browser.goBack":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [link] Previous",
                    "elementCount": 1,
                    "newUrl": "https://example.com/prev",
                    "newTitle": "Previous",
                },
            )

        elif method == "browser.press":
            write_response(
                req_id,
                result={
                    "success": True,
                    "snapshot": "- @e1 [button] Pressed",
                    "elementCount": 1,
                },
            )

        elif method == "browser.screenshot":
            write_response(
                req_id,
                result={
                    "success": True,
                    "dataUri": "data:image/jpeg;base64,mock",
                },
            )

        elif method == "browser.getImages":
            write_response(
                req_id,
                result={
                    "success": True,
                    "images": [{"src": "https://example.com/img.png", "alt": "test", "width": 100, "height": 50}],
                },
            )

        elif method == "browser.getConsoleMessages":
            write_response(
                req_id,
                result={
                    "success": True,
                    "messages": [{"type": "log", "text": "hello from mock"}],
                },
            )

        elif method == "browser.clearConsole":
            write_response(req_id, result={"success": True})

        elif method == "browser.evaluate":
            write_response(
                req_id,
                result={
                    "success": True,
                    "result": 42,
                },
            )

        elif method == "browser.cleanup":
            write_response(req_id, result={"success": True})

        elif method == "browser.error":
            # Return an application error for testing error handling
            write_response(
                req_id,
                error={
                    "code": -32000,
                    "message": "Something went wrong",
                    "data": {"traceback": "Traceback (most recent call last):\n  File \"mock.py\", line 1, in <module>\nRuntimeError: test error"},
                },
            )

        elif method == "browser.missingSession":
            # Session error
            write_response(
                req_id,
                error={
                    "code": -32002,
                    "message": "No active session for task 'test'",
                },
            )

        elif method == "browser.timeout":
            # Simulate a timeout by not responding
            # (the caller's transport timeout will fire)
            pass

        else:
            write_response(
                req_id,
                error={"code": -32601, "message": f"Method not found: {method}"},
            )


def write_response(req_id: object, result: object = None, error: object = None) -> None:
    """Write a JSON-RPC response line to stdout."""
    response: dict[str, object] = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        response["error"] = error
    else:
        response["result"] = result
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
