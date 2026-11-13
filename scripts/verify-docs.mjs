import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapters = ['codex', 'claude-code', 'workbuddy', 'doubao', 'dsh', 'agy'];

const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(path => path.endsWith('.md'));
const read = path => readFile(join(root, path), 'utf8');

// Published plugin guides are the wording baseline. Scan every source Markdown
// document (including Skills/specifications), not only Chinese-named READMEs.
const disallowedWording = [
  '线级协议', '自然最终回复', '自然最终文本', '密钥代次',
  'Nia 执行段', '执行段切换', '执行段轮换', '发到新执行段', '执行段未切换',
  '独立能力令牌', '转交 TaskBar', '工具确认转交', '支持审批转交', '支持卡片转交',
  '宿主转交工具权限请求', '上游转交工具权限请求', 'macOS 活跃轮次',
];
test('source Markdown follows published terminology without literal translations or internal jargon', async () => {
  const violations = [];
  for (const path of paths) {
    const text = await read(path);
    for (const [index, line] of text.split('\n').entries()) {
      for (const term of disallowedWording) if (line.includes(term)) violations.push(`${path}:${index + 1}: ${term}`);
      if (/natural final (?:repl(?:y|ies)|text|publication)/i.test(line)) violations.push(`${path}:${index + 1}: literal English reply wording`);
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('adapter guides name their runtime and describe the browser pairing completion', async () => {
  for (const name of ['codex', 'workbuddy', 'doubao', 'agy']) {
    const text = await read(`packages/${name}/README_CN.md`);
    assert.ok(!text.includes('上游'), `${name}: name the product in its own guide`);
    for (const label of ['任意设备的浏览器', '新建外部 Agent', 'Paired: <Agent 名称> (@external-...)', '直接发起新对话', '拉进已有群聊', '临时离线', '更换主机或解绑主机', '停用归档', '常见问题排查']) assert.ok(text.includes(label), `${name}: missing ${label}`);
  }
  const claude = await read('packages/claude-code/README_CN.md');
  const pairing = claude.slice(claude.indexOf('### 第 2 步：'), claude.indexOf('### 第 3 步：'));
  assert.equal((pairing.match(/1\. 填写 \*\*Agent 名称/g) ?? []).length, 1);
  assert.ok(!pairing.includes('在运行 Claude Code 的电脑上配对一次。'));
  assert.ok(pairing.includes('Paired: <Agent 名称> (@external-...)'));
});

test('all repository Markdown links and images resolve', async () => {
  for (const path of paths) {
    for (const [, target] of (await read(path)).matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z]+:|\/|#)/i.test(target)) continue;
      await assert.doesNotReject(access(join(root, posix.dirname(path), target.split('#')[0])), `${path}: ${target}`);
    }
  }
});

test('package CLI, process checks, environment variables and install names do not leak across adapters', async () => {
  const names = [...adapters, 'core'];
  const packages = await Promise.all(names.map(async name => JSON.parse(await read(`packages/${name}/package.json`))));
  for (const [i, name] of names.entries()) {
    const ownCli = name === 'claude-code' ? 'claude' : name;
    for (const path of paths.filter(path => path.startsWith(`packages/${name}/`))) {
      const text = (await read(path)).replaceAll('[n]ia-', 'nia-');
      for (const [, cli] of text.matchAll(/\bnia-(codex|claude|workbuddy|doubao|dsh|agy)\b/g)) assert.equal(cli, ownCli, `${path}: wrong CLI ${cli}`);
      for (const [, env] of text.matchAll(/\bNIA_(CODEX|CLAUDE|WORKBUDDY|DOUBAO|DSH|AGY)_CONFIG_DIR\b/g)) assert.equal(env.toLowerCase(), ownCli, `${path}: wrong config environment variable`);
      for (const pkg of packages.filter((_, j) => j !== i && names[j] !== 'core')) assert.ok(!text.includes(pkg.name), `${path}: unexpected package ${pkg.name}`);
    }
  }
});

test('root guides list core plus six adapters in the same order and nest launch sections 1–6', async () => {
  const order = ['core', ...adapters];
  for (const path of ['README.md', 'README_CN.md']) {
    const text = await read(path);
    assert.deepEqual([...text.matchAll(/^  ([a-z-]+)\/ /gm)].map(match => match[1]), order, path);
    assert.deepEqual([...text.matchAll(/^### ([1-6])\. /gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6], path);
    const packageTable = text.slice(text.indexOf('| ---'), text.indexOf('\n## ', text.indexOf('| ---')));
    const manifests = await Promise.all(order.map(name => read(`packages/${name}/package.json`).then(JSON.parse)));
    let previous = -1;
    for (const pkg of manifests) {
      const position = packageTable.indexOf(pkg.name);
      assert.ok(position > previous, `${path}: package navigation order for ${pkg.name}`);
      previous = position;
    }
  }
  const spec = await read('docs/SPECIFICATION.md');
  assert.deepEqual([...spec.matchAll(/^\| (Codex|Claude Code|WorkBuddy|Doubao|DSH|Antigravity) \|/gm)].map(match => match[1]), ['Codex', 'Claude Code', 'WorkBuddy', 'Doubao', 'DSH', 'Antigravity']);
  assert.match(await read('README_CN.md'), /Doubao）\*\*、\*\*DeepSeek Harness（DSH）\*\* 与 \*\*Google Antigravity/);
  assert.match(await read('README.md'), /\*\*DeepSeek Harness \(DSH\)\*\*, and \*\*Google Antigravity/);
});

test('root entry and common setup cover all six platforms without a default Codex walkthrough', async () => {
  const manifests = await Promise.all(adapters.map(name => read(`packages/${name}/package.json`).then(JSON.parse)));
  for (const path of ['README.md', 'README_CN.md']) {
    const text = await read(path);
    const entry = text.slice(0, text.indexOf('\n## '));
    const common = text.slice(text.indexOf(path === 'README.md' ? '## 2.' : '## 二、'), text.indexOf(path === 'README.md' ? '## 3.' : '## 三、'));
    const stepOne = common.slice(0, common.indexOf(path === 'README.md' ? '### Step 2:' : '### 第 2 步：'));
    for (const section of [entry, stepOne]) {
      for (const manifest of manifests) assert.ok(section.includes(manifest.name), `${path}: missing ${manifest.name}`);
      assert.match(section, /dsh plugin --profile web add @nia-teams\/dsh-plugin/);
    }
    assert.doesNotMatch(entry, /node_modules\/@nia-teams\/codex-bridge/);
    for (const section of [entry, common]) {
      assert.match(section, /<nia-cli> pair --name 'My Local Agent'/);
      assert.match(section, /nohup <nia-cli> start --cwd/);
      assert.match(section, /npx --prefix ~\/\.dsh\/profiles\/web nia-dsh pair --label 'My DSH'/);
      assert.match(section, /nohup dsh web/);
      assert.doesNotMatch(section, /^(?:nohup )?nia-codex (?:pair|start|status)|@openai\/codex/gm);
    }
    assert.match(common, /<nia-cli> status/);
    assert.match(common, /^<nia-cli> start --cwd \/path\/to\/workspace$/m);
    assert.match(common, /npx --prefix ~\/\.dsh\/profiles\/web nia-dsh status/);
    // Placeholders are explanatory, not executable: validate snippets after substitution.
    for (const section of [entry, common]) {
      for (const [, snippet] of section.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
        for (const cli of ['nia-claude', 'nia-codex', 'nia-agy', 'nia-workbuddy', 'nia-doubao']) execFileSync('sh', ['-n'], { input: snippet.replaceAll('<nia-cli>', cli) });
      }
    }
  }
});

test('source Markdown has a real H1 and no frontmatter except Skill metadata', async () => {
  for (const path of paths) {
    const text = await read(path);
    // Ignore fenced examples when looking for document headings.
    const body = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
    assert.match(body, /^# \S.+$/m, `${path}: missing H1`);
    if (path.endsWith('/SKILL.md')) {
      const metadata = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      assert.ok(metadata, `${path}: missing Skill metadata`);
      assert.deepEqual([...metadata[1].matchAll(/^([a-zA-Z][\w-]*):/gm)].map(match => match[1]).sort(), ['description', 'name'], `${path}: only Skill name and description are allowed`);
    } else {
      assert.doesNotMatch(text, /^---[ \t]*\r?\n/, `${path}: source documents must not have frontmatter`);
    }
  }
});

test('daemon guides document portable launch, private logs, and readiness checks', async () => {
  for (const name of ['claude-code', 'codex', 'agy', 'workbuddy', 'doubao']) {
    const skill = await read(`packages/${name}/skills/nia-teams-${name}/SKILL.md`);
    assert.match(skill, /start --cwd "\." --daemon/);
    assert.match(skill, /--log-file/);
    assert.match(skill, /daemon\.log/);
    assert.match(skill, /PowerShell/);
    assert.doesNotMatch(skill, /nohup nia-\S+ start/);
  }
  for (const path of ['README.md', 'README_CN.md']) {
    const text = await read(path);
    assert.match(text, /<nia-cli> start --cwd .* --daemon/);
    assert.match(text, /--log-file/);
  }
});
