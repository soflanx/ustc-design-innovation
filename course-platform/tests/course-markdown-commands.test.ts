import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lexer, type Tokens } from 'marked';
import { applyMarkdownCommand, applyMarkdownLink, markdownEnter, markdownIndent, type MarkdownSnapshot } from '../src/lib/course-markdown-commands';
import { collectCourseMarkdownReferences } from '../src/lib/course-markdown-references';

const selection = (source: string, start = 0, end = source.length): MarkdownSnapshot => ({ source, start, end });
const caret = (source: string, start = source.length) => selection(source, start, start);
const selected = (snapshot: MarkdownSnapshot) => snapshot.source.slice(snapshot.start, snapshot.end);

test('行内命令只包裹实际选区，保留选中的受管引用和 UTF-16 选区', () => {
  const reference = '[读课次](course:pages/lesson-1)';
  const phrase = `原型🧪与${reference}`;
  const original = selection(`先读 ${phrase}，再讨论。`, 3, 3 + phrase.length);
  const bold = applyMarkdownCommand(original, 'bold');
  assert.equal(bold.source, `先读 **${phrase}**，再讨论。`);
  assert.equal(selected(bold), phrase);
  assert.deepEqual(collectCourseMarkdownReferences(bold.source), [{ kind: 'pages', id: 'lesson-1' }]);
  assert.deepEqual(applyMarkdownCommand(bold, 'bold'), original);

  const filled = applyMarkdownCommand(caret('先讨论，再回顾。', 4), 'strike');
  assert.equal(selected(filled), '文字');
  assert.equal(filled.source, '先讨论，~~文字~~再回顾。');
  assert.deepEqual(applyMarkdownCommand(selection('_观察_'), 'italic'), selection('观察'));
});

test('切换格式仅移除真正包住整个选区的语法，已有的两段粗体仍完整', () => {
  const original = '**第一段** 和 **第二段**';
  const edited = applyMarkdownCommand(selection(original), 'bold');
  assert.equal(selected(edited), original);
  const [outer] = Lexer.lexInline(edited.source, { gfm: true });
  assert.equal(outer.type, 'strong');
  assert.equal(outer.raw, edited.source);

  const withSpaces = applyMarkdownCommand(selection('边界  主题  边界', 2, 8), 'italic');
  assert.equal(withSpaces.source, '边界  *主题*  边界');
  assert.equal(selected(withSpaces), '主题');
});

test('行格式切换保留未选行、空白和旧块标记，列表转换不会叠加标记', () => {
  const original = '- 观察\r\n续写\r\n原有下一行';
  const end = original.indexOf('原有下一行');
  const bullets = applyMarkdownCommand(selection(original, 2, end), 'bullet');
  assert.equal(bullets.source, '- 观察\r\n- 续写\r\n原有下一行');
  assert.equal(selected(bullets), '观察\r\n- 续写\r\n');
  const numbered = applyMarkdownCommand(bullets, 'ordered');
  assert.equal(numbered.source, '1. 观察\r\n2. 续写\r\n原有下一行');
  assert.equal(applyMarkdownCommand(numbered, 'ordered').source, '观察\r\n续写\r\n原有下一行');
  const numberedWithStart = applyMarkdownCommand(selection('7. 上次\n本次'), 'ordered');
  assert.equal(numberedWithStart.source, '7. 上次\n8. 本次');

  const opaque = '[保留受限资料引用](course-keep:block-__locked_test)';
  const protectedSource = `回顾\n\n${opaque}\n\n准备`;
  const formatted = applyMarkdownCommand(selection(protectedSource), 'quote');
  assert.equal(formatted.source, `> 回顾\n\n${opaque}\n\n> 准备`);
  assert.equal(applyMarkdownCommand(selection(protectedSource), 'codeBlock').source, protectedSource);
  const title = applyMarkdownCommand(caret('正文\n'), 'heading');
  assert.equal(title.source, '正文\n## 标题');
  assert.equal(selected(title), '标题');
  const task = applyMarkdownCommand(caret(''), 'task');
  assert.equal(task.source, '- [ ] 待办事项');
  assert.equal(selected(task), '待办事项');
});

test('行内及成块代码选用足够长的围栏，原样保留示例中的反引号', () => {
  const code = '`const x`';
  const inline = applyMarkdownCommand(selection(code), 'inlineCode');
  // Select the inner literal by adding a backtick to both edges of the input.
  assert.equal(inline.source, 'const x');
  const literal = '使用 `x` 访问';
  const formatted = applyMarkdownCommand(selection(literal), 'inlineCode');
  const [inlineToken] = Lexer.lexInline(formatted.source);
  assert.equal(inlineToken.type, 'codespan');
  assert.equal((inlineToken as Tokens.Codespan).text, literal);
  assert.equal(selected(formatted), literal);
  assert.deepEqual(applyMarkdownCommand(formatted, 'inlineCode'), selection(literal));

  const example = '```md\n[旧示例](course:pages/example)\n```';
  const block = applyMarkdownCommand(selection(example), 'codeBlock');
  const [codeToken] = Lexer.lex(block.source);
  assert.equal(codeToken.type, 'code');
  assert.equal((codeToken as Tokens.Code).text, example);
  assert.equal(selected(block), example);
});

test('表格和分隔线落成独立 Markdown 块，多行或管道文字仍完整', () => {
  const multi = '第一列 | 第二列\n下一行';
  const table = applyMarkdownCommand(selection(multi), 'table');
  assert.ok(table.source.startsWith(multi + '\n\n'));
  assert.ok(Lexer.lex(table.source, { gfm: true }).some(token => token.type === 'table'));
  assert.equal(selected(table), '列名');
  const cell = applyMarkdownCommand(selection('保留词语'), 'table');
  assert.equal(selected(cell), '保留词语');
  const [parsed] = Lexer.lex(cell.source, { gfm: true });
  assert.equal((parsed as Tokens.Table).rows[0][0].text, '保留词语');

  const rule = applyMarkdownCommand(selection('回顾\n下一节', 0, 2), 'rule');
  assert.equal(rule.source, '回顾\n\n---\n\n下一节');
  assert.equal(rule.start, rule.source.indexOf('下一节'));
  assert.ok(Lexer.lex(rule.source).some(token => token.type === 'hr'));
});

test('回车续写带缩进的有序、无序和待办列表，空项退出且保留后续正文', () => {
  const input = '- 任务\n  9. 先看材料';
  assert.deepEqual(markdownEnter(caret(input)), caret(input + '\n  10. '));
  const task = '> - [x] 已完成';
  assert.deepEqual(markdownEnter(caret(task)), caret(task + '\n> - [ ] '));
  assert.deepEqual(markdownEnter(caret('- 左右', 3)), caret('- 左\n- 右', 6));
  const exit = '1. 一项\n2. \n\n后文';
  assert.deepEqual(markdownEnter(caret(exit, exit.indexOf('\n\n'))), caret('1. 一项\n\n\n后文', '1. 一项\n'.length));
});

test('连续两次回车先续写待办再退出末尾空项，且不删除后文或改写围栏', () => {
  const task = '- [ ] 准备新原型';
  const next = markdownEnter(caret(task));
  assert.deepEqual(next, caret(`${task}\n- [ ] `));
  assert.deepEqual(markdownEnter(next!), caret(`${task}\n`));
  const followed = `${next!.source}\n\n下一节说明`;
  assert.deepEqual(markdownEnter(caret(followed, next!.end)), caret(`${task}\n\n\n下一节说明`, task.length + 1));
  assert.deepEqual(markdownEnter(caret('- 初稿\n- ')), caret('- 初稿\n'));
  assert.deepEqual(markdownEnter(caret('1. 初稿\n2. ')), caret('1. 初稿\n'));
  assert.equal(markdownEnter(caret('```md\n- [ ] ')), null);
});

test('普通回车以及围栏和缩进代码中的列表形文字交回原生行为', () => {
  for (const source of ['一行普通正文', '- - -', '    - 缩进代码', '```md\n- 围栏文字\n```', '~~~\n- 波浪线围栏', '> ```md\n> - 引用中的代码\n> ```', '- ```\n  - 列表里的代码\n  ```']) {
    const closing = source.lastIndexOf('\n');
    const stop = /^(?:> |  )?```$/.test(source.slice(closing + 1)) ? closing : source.length;
    assert.equal(markdownEnter(caret(source, stop)), null, source);
  }
  const afterFence = '> ```md\n> - 引用中的代码\n\n- 新列表';
  assert.deepEqual(markdownEnter(caret(afterFence)), caret(afterFence + '\n- '));
  assert.equal(markdownEnter(selection('- 选中的文字', 2)), null);
});

test('多行缩进和取消缩进维持选区，不吞掉普通正文的 Tab 或未选下一行', () => {
  const source = '- 一\n- 二\n三';
  const original = selection(source, 2, source.indexOf('三'));
  const indented = markdownIndent(original);
  assert.equal(indented.source, '  - 一\n  - 二\n三');
  assert.equal(selected(indented), '一\n  - 二\n');
  assert.deepEqual(markdownIndent(indented, true), original);
  const ordinary = caret('正常浏览器焦点顺序');
  assert.equal(markdownIndent(ordinary), ordinary);
  assert.equal(markdownIndent(caret('- 当前项')).source, '  - 当前项');
});

test('重复缩进不会把受管引用变成代码，取消缩进不会激活代码里的示例', () => {
  const reference = '[观察报告](course:assignments/work)';
  const first = markdownIndent(selection(`先完成以下任务。\n\n${reference}`));
  assert.equal(first.source, `  先完成以下任务。\n\n  ${reference}`);
  assert.deepEqual(collectCourseMarkdownReferences(first.source), [{ kind: 'assignments', id: 'work' }]);
  assert.equal(markdownIndent(first), first);

  const example = selection(`    ${reference}`);
  assert.deepEqual(collectCourseMarkdownReferences(example.source), []);
  assert.equal(markdownIndent(example, true), example);

  const list = `- 课堂安排\n- ${reference}`;
  const nested = markdownIndent(caret(list));
  assert.equal(nested.source, `- 课堂安排\n  - ${reference}`);
  assert.deepEqual(collectCourseMarkdownReferences(nested.source), [{ kind: 'assignments', id: 'work' }]);
  assert.deepEqual(markdownIndent(nested, true), caret(list));
});

test('普通链接沿用已选文字，带括号的地址可读，已有教学引用保持独立', () => {
  const href = 'https://example.org/read_(part)';
  const linked = applyMarkdownLink(selection('看 [附录]'), href);
  const [token] = Lexer.lexInline(linked.source, { gfm: true });
  assert.equal(token.type, 'link');
  assert.equal((token as Tokens.Link).href, href);
  assert.match(selected(linked), /附录/);

  const source = '[本课](course\\:pages/lesson-1)\n\n后文';
  const newLink = applyMarkdownLink(selection(source, 0, source.indexOf('\n')), href, '延伸阅读');
  assert.equal(newLink.source, `[本课](course\\:pages/lesson-1)\n\n[延伸阅读](<${href}>)\n\n后文`);
  assert.equal(selected(newLink), '延伸阅读');
  assert.deepEqual(collectCourseMarkdownReferences(newLink.source), [{ kind: 'pages', id: 'lesson-1' }]);
});

test('局部选中受管链接标题或语法时，新增普通链接落在完整原文之后', () => {
  const href = 'https://example.org/more';
  const reference = '[观察报告](course:assignments/work)';
  const source = `先完成${reference}再记录。`;
  for (const partial of ['报告](course:', '观察报告']) {
    const start = source.indexOf(partial);
    const linked = applyMarkdownLink(selection(source, start, start + partial.length), href);
    assert.equal(linked.source, `${source}\n\n[链接文字](<${href}>)\n\n`);
    assert.equal(selected(linked), '链接文字');
    assert.deepEqual(collectCourseMarkdownReferences(linked.source), [{ kind: 'assignments', id: 'work' }]);
    const [token] = Lexer.lexInline(linked.source.slice(source.length).trim(), { gfm: true });
    assert.equal(token.type, 'link');
    assert.equal((token as Tokens.Link).href, href);
  }

  const plain = '再记录';
  const start = source.indexOf(plain);
  const sameLine = applyMarkdownLink(selection(source, start, start + plain.length), href);
  assert.equal(sameLine.source, `先完成${reference}[${plain}](<${href}>)。`);
});

test('多行引用中的选择也不会拆开引用或其引用段', () => {
  const quoted = '> 先看[观察\n> 报告](course:assignments/work)再讨论。';
  const source = `${quoted}\n\n其他安排`;
  const start = source.indexOf('观察');
  const href = 'https://example.org/more';
  const linked = applyMarkdownLink(selection(source, start, start + 2), href, '延伸阅读');
  assert.equal(linked.source, `${quoted}\n\n[延伸阅读](<${href}>)\n\n其他安排`);
  assert.deepEqual(collectCourseMarkdownReferences(linked.source), [{ kind: 'assignments', id: 'work' }]);
  assert.equal(selected(linked), '延伸阅读');
});
