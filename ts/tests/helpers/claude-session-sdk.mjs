// Fake only the external SDK. Connector, worker, index I/O and poller stay real.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export async function* query({options}) {
  const index = JSON.parse(readFileSync(join(options.env.DETACH_CLAUDE_INDEX_DIR, `${options.sessionId}.json`), 'utf8'));
  appendFileSync(join(options.cwd, 'sdk-options.jsonl'), JSON.stringify({sessionId: options.sessionId, index}) + '\n');
  yield {type: 'assistant', message: {content: [{type: 'text', text: 'session indexed'}]}};
  yield {type: 'result', subtype: 'success', result: 'session indexed', usage: {input_tokens: 1, output_tokens: 1}};
}
