import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createSession, database, initializeDatabase } from '../lib/db.ts';
import { createFsController, parseFsInput } from '../lib/fs-tool.ts';
import { docxToText } from '../lib/document-export.ts';
import { listSkills } from '../lib/skills.ts';
import { listSessionFiles, readSessionFile, writeSessionFile } from '../lib/workspace-files.ts';

await initializeDatabase();
const session = await createSession({ title: 'fs test' });
const fs = createFsController({ sessionId: session.id });

// input parsing
assert.deepEqual(parseFsInput({ action: 'ls' }), { action: 'ls' });
assert.deepEqual(parseFsInput({ action: 'read', path: '/workspace/a.md' }), { action: 'read', path: '/workspace/a.md' });
assert.throws(() => parseFsInput({ action: 'read' }), /requires path/);
assert.throws(() => parseFsInput({ action: 'write', path: '/workspace/a.md' }), /requires content/);
assert.throws(() => parseFsInput({ action: 'rm', path: '/workspace/a.md' }), /action must be one of/);

// invalid paths
await assert.rejects(fs.run({ action: 'read', path: 'workspace/a.md' }), /Invalid fs path/);
await assert.rejects(fs.run({ action: 'read', path: '/other/a.md' }), /Invalid fs path/);
await assert.rejects(fs.run({ action: 'write', path: '/workspace/../evil', content: 'x' }), /Invalid fs path|Invalid file name/);

// workspace write + read text
const written = await fs.run({ action: 'write', path: '/workspace/report.md', content: '# Report\n\n结论正文' });
assert.deepEqual(written, { action: 'write', path: '/workspace/report.md', size: written.action === 'write' ? written.size : 0, mimeType: 'text/markdown' });
const readBack = await fs.run({ action: 'read', path: '/workspace/report.md' });
assert.equal(readBack.action === 'read' && 'content' in readBack ? readBack.content : '', '# Report\n\n结论正文');

// docx conversion path
const docxResult = await fs.run({ action: 'write', path: '/workspace/report.docx', content: '# 标题\n\n中文段落' });
assert.equal(docxResult.action === 'write' ? docxResult.mimeType : '', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
const docxFile = await readSessionFile(session.id, 'report.docx');
assert.match(await docxToText(docxFile!.data), /标题[\s\S]*中文段落/);

// binary read returns metadata + hint
const binaryRead = await fs.run({ action: 'read', path: '/workspace/report.docx' });
assert.equal(binaryRead.action === 'read' && 'binary' in binaryRead ? binaryRead.binary : false, true);
assert.match(binaryRead.action === 'read' && 'hint' in binaryRead ? binaryRead.hint : '', /getDocument/);

// unsupported write extension
await assert.rejects(fs.run({ action: 'write', path: '/workspace/photo.png', content: 'x' }), /supports text files/);
await assert.rejects(fs.run({ action: 'write', path: '/workspace/report.pdf', content: 'x' }), /PDF output/);

// skills write via frontmatter + read + rename cleanup
const skillFile = '---\nname: HN top stories\nhosts: news.ycombinator.com\ndescription: Fetch HN front page fast\n---\n\nUse https://hacker-news.firebaseio.com/v0/topstories.json';
const skillWrite = await fs.run({ action: 'write', path: '/skills/hn-top-stories.md', content: skillFile });
assert.equal(skillWrite.action === 'write' ? skillWrite.path : '', '/skills/hn-top-stories.md');
const skillRead = await fs.run({ action: 'read', path: '/skills/hn-top-stories.md' });
assert.match(skillRead.action === 'read' && 'content' in skillRead ? skillRead.content : '', /^---\nname: HN top stories/);
await assert.rejects(fs.run({ action: 'write', path: '/skills/bad.txt', content: skillFile }), /must end with \.md/);
await assert.rejects(fs.run({ action: 'write', path: '/skills/no-front.md', content: 'no frontmatter' }), /frontmatter/);

// renaming a skill via the same file replaces it instead of duplicating
const renamed = skillFile.replace('name: HN top stories', 'name: HN front page');
const renameWrite = await fs.run({ action: 'write', path: '/skills/hn-top-stories.md', content: renamed });
assert.equal(renameWrite.action === 'write' ? renameWrite.path : '', '/skills/hn-front-page.md');
assert.equal((await listSkills()).length, 1);

// renaming into a slug that collides with another skill fails atomically: nothing is deleted
await fs.run({ action: 'write', path: '/skills/other.md', content: '---\nname: Other flow\nhosts: example.com\ndescription: d\n---\nbody' });
await assert.rejects(
  fs.run({ action: 'write', path: '/skills/other.md', content: '---\nname: HN-front page\nhosts: example.com\ndescription: d\n---\nbody' }),
  /Skill name conflict/,
);
const survivingPaths = ((await fs.run({ action: 'ls' })) as { skills: { path: string }[] }).skills.map((entry) => entry.path).sort();
assert.deepEqual(survivingPaths, ['/skills/hn-front-page.md', '/skills/other-flow.md']);
assert.equal(new Set(survivingPaths).size, survivingPaths.length);
const otherIntact = await fs.run({ action: 'read', path: '/skills/other-flow.md' });
assert.match(otherIntact.action === 'read' && 'content' in otherIntact ? otherIntact.content : '', /name: Other flow/);
await (await import('../lib/skills.ts')).deleteSkill((await listSkills()).find((skill) => skill.name === 'Other flow')!.id);

// ls shows both namespaces
const listing = await fs.run({ action: 'ls' });
assert.equal(listing.action, 'ls');
if (listing.action === 'ls') {
  assert.deepEqual(listing.workspace.map((entry) => entry.path).sort(), ['/workspace/report.docx', '/workspace/report.md']);
  assert.deepEqual(listing.skills.map((entry) => entry.path), ['/skills/hn-front-page.md']);
  assert.equal(listing.skills[0].description, 'Fetch HN front page fast');
}

// read truncation
await writeSessionFile({ sessionId: session.id, name: 'big.txt', data: new TextEncoder().encode('x'.repeat(50_000)).buffer as ArrayBuffer });
const bigRead = await fs.run({ action: 'read', path: '/workspace/big.txt' });
assert.equal(bigRead.action === 'read' && 'truncated' in bigRead ? bigRead.truncated : false, true);
assert.equal(bigRead.action === 'read' && 'content' in bigRead ? bigRead.content.length : 0, 40_000);

// session isolation + prune cascade
const otherSession = await createSession({ title: 'other' });
const otherFs = createFsController({ sessionId: otherSession.id });
const otherList = await otherFs.run({ action: 'ls' });
assert.equal(otherList.action === 'ls' ? otherList.workspace.length : -1, 0);
assert.equal(otherList.action === 'ls' ? otherList.skills.length : -1, 1); // skills are global

assert.equal((await listSessionFiles(session.id)).length, 3);
await database.files.where('sessionId').equals(session.id).delete();

console.log('test-fs-tool passed');
