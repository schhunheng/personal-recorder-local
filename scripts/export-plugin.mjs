import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const maxBytes = 256 * 1024 * 1024;
// Local Vite-only conversion. No cloud service or remote upload is used.
export function exportPlugin(converter = null) {
  let busy = false;
  return {
    name: 'local-video-export',
    configureServer(server) {
      const videoExport = converter ?? require(join(server.config.root, 'electron/export-video.cjs'));
      server.middlewares.use('/api/video-export', async (request, response) => {
        const send = (status, body) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
        const host = request.headers.host;
        if (host !== '127.0.0.1:5173' && host !== 'localhost:5173') { send(403, { error: 'Local requests only' }); return; }
        if (request.method === 'GET') { send(200, await videoExport.capabilities()); return; }
        if (request.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
        if (request.headers.origin !== `http://${host}` || request.headers['x-recorder-export'] !== '1') { send(403, { error: 'Same-origin requests only' }); return; }
        const format = new URL(request.url, `http://${host}`).searchParams.get('format');
        if (!['mp4', 'mov'].includes(format)) { send(400, { error: 'Choose MP4 or MOV' }); return; }
        if (busy) { send(409, { error: 'An export is already running' }); return; }
        if (Number(request.headers['content-length']) > maxBytes) { send(413, { error: 'Browser export is limited to 256 MB' }); return; }
        busy = true;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > maxBytes) { send(413, { error: 'Browser export is limited to 256 MB' }); return; }
            chunks.push(chunk);
          }
          if (!size) { send(400, { error: 'Recording is empty' }); return; }
          const result = await videoExport.convertBytes(Buffer.concat(chunks), format);
          response.setHeader('Content-Type', videoExport.formats[format].mime);
          response.setHeader('Content-Length', result.length);
          response.end(result);
        } catch (error) { if (!response.writableEnded) send(500, { error: error.message }); }
        finally { busy = false; }
      });
    },
  };
}
