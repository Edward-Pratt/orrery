import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { noteText, why } from './save-upload';

describe('save upload', () => {
  const base = { file: 'My World.zip', sent: 512, size: 1024 };
  it('says each step of a saveUpload note as one line', () => {
    expect(noteText({ ...base, state: 'sending' })).toBe('Sending My World.zip to the server: 50%');
    expect(noteText({ ...base, state: 'storing' })).toBe('The server is checking My World.zip…');
    expect(noteText({ ...base, state: 'done', name: 'uploaded-20300101T000000Z-My-World.zip' })).toBe(
      'Stored My World.zip as uploaded-20300101T000000Z-My-World.zip. To load it: stop the server, then Restore it from the list below.',
    );
    expect(noteText({ ...base, state: 'failed', error: 'no room' })).toBe('Uploading My World.zip failed: no room');
  });

  it("shows the hub's refusal, or names the hub release an older one needs", () => {
    expect(why(new HttpErrorResponse({ status: 409, error: 'A save is already being uploaded to this server.' }))).toBe('A save is already being uploaded to this server.');
    expect(why(new HttpErrorResponse({ status: 404, error: null }))).toMatch(/deploy hub-v2\.19\.0/);
    expect(why(new Error('offline'))).toBe('offline');
  });
});
