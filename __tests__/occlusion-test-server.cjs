/**
 * Test server for occlusion live testing.
 * Serves modal, icon-button, and normal pages.
 * Run: node this-file.js
 */
const http = require("http");

const MODAL_HTML = `<!DOCTYPE html><html><body>
  <h1>Modal Test Page</h1>
  <button id="bg-btn" style="padding:8px">Background Button</button>
  <div id="modal-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999;display:flex;align-items:center;justify-content:center;">
    <div id="modal-dialog" style="background:white;padding:2rem;border-radius:8px;text-align:center;">
      <h2>Cookie Preferences</h2>
      <button id="close-btn" onclick="document.getElementById('modal-overlay').style.display='none';window._closeClicked=true" style="padding:8px 16px;font-size:16px;cursor:pointer;">
        <span aria-hidden="true" style="display:inline-block">✕</span> Close
      </button>
      <button id="accept-btn" onclick="document.getElementById('modal-overlay').style.display='none';window._acceptClicked=true" style="padding:8px 16px;margin-left:8px;cursor:pointer;">Accept All</button>
    </div>
  </div>
  <a href="/" style="display:block;margin-top:4rem">Footer Link</a>
</body></html>`;

const ICON_BTN_HTML = `<!DOCTYPE html><html><body>
  <h1>Icon Button Test</h1>
  <button id="svg-btn" onclick="window._svgClicked=true" style="padding:8px 16px;cursor:pointer;border:1px solid #ccc;border-radius:4px;">
    <svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2"/>
    </svg>
    <span style="vertical-align:middle">Close Dialog</span>
  </button>
  <button id="img-btn" onclick="window._imgClicked=true" style="padding:8px 16px;cursor:pointer;border:1px solid #ccc;border-radius:4px;">
    <img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><circle cx='8' cy='8' r='6' fill='%23ccc'/></svg>" width="16" height="16" alt="" style="vertical-align:middle" aria-hidden="true">
    <span style="vertical-align:middle">Dismiss</span>
  </button>
  <hr>
  <a href="/" id="nav-link">Back to Home</a>
</body></html>`;

const DEFAULT = `<!DOCTYPE html><html><body>
  <h1>Home</h1>
  <a href="/modal">Modal Page</a>
  <a href="/icon-btn">Icon Button Page</a>
</body></html>`;

const server = http.createServer((req, res) => {
	if (req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(DEFAULT);
	} else if (req.url === "/modal") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(MODAL_HTML);
	} else if (req.url === "/icon-btn") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(ICON_BTN_HTML);
	} else {
		res.writeHead(404);
		res.end("Not found");
	}
});

server.listen(0, "127.0.0.1", () => {
	const addr = server.address();
	console.log(`TEST_SERVER_URL=${addr.address}:${addr.port}`);
	console.log("Pages:");
	console.log(`  /         — Home`);
	console.log(`  /modal    — Modal overlay page`);
	console.log(`  /icon-btn — Icon button page`);
});
