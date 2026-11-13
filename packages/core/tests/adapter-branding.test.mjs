import test from 'node:test';
import assert from 'node:assert/strict';

// Product knowledge belongs in the adapters, never in the protocol or server.
for (const adapter of ['dsh', 'claude-code', 'codex', 'agy', 'workbuddy', 'doubao']) {
  test(`${adapter} ships a portable, bounded 256x256 PNG and product name`, async () => {
    const { clientBranding } = await import(`../../${adapter}/dist/branding.js`);
    assert.ok(clientBranding.clientName.length > 0 && clientBranding.clientName.length <= 80);
    assert.match(clientBranding.avatar, /^data:image\/png;base64,/);
    const png = Buffer.from(clientBranding.avatar.split(',')[1], 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length <= 65536);
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 256);
  });
}
