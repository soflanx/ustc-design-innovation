import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { createCourseBlockSelection, selectedCourseBlockIds, WholeBlockSelection } from '../src/lib/course-block-selection';

// Match the editor's blockGroup > blockContainer > blockContent structure,
// including leaf references/media and nested child groups.
const schema = new Schema({ nodes: {
  doc: { content: 'blockGroup' },
  blockGroup: { content: 'blockContainer+' },
  blockContainer: { attrs: { id: { default: null } }, content: 'blockContent blockGroup?' },
  paragraph: { group: 'blockContent', content: 'text*' },
  courseRecord: { group: 'blockContent', atom: true },
  image: { group: 'blockContent', atom: true },
  text: { group: 'inline' },
} });
const block = (id: string, type = 'paragraph', children: ProseMirrorNode[] = []) => schema.node('blockContainer', { id }, [
  schema.node(type, null, type === 'paragraph' ? [schema.text(id)] : undefined),
  ...(children.length ? [schema.node('blockGroup', null, children)] : []),
]);
const document = (...blocks: ProseMirrorNode[]) => schema.node('doc', null, schema.node('blockGroup', null, blocks));
const position = (doc: ProseMirrorNode, id: string) => {
  let result = -1;
  doc.descendants((node, pos) => { if (node.type.name === 'blockContainer' && node.attrs.id === id) result = pos; });
  if (result < 0) throw new Error(`missing ${id}`);
  return result;
};
const ids = (doc: ProseMirrorNode) => Array.from({ length: doc.firstChild!.childCount }, (_, index) => doc.firstChild!.child(index).attrs.id);

test('文字、作业引用与图片可作为范围端点，反向选择保持页面顺序并完整保留子块', () => {
  const doc = document(block('before'), block('record', 'courseRecord'), block('middle', 'paragraph', [block('child')]), block('image', 'image'), block('after'));
  for (const pair of [['record', 'image'], ['image', 'record']]) {
    const selection = createCourseBlockSelection(doc, ...pair as [string, string]);
    assert.ok(selection instanceof WholeBlockSelection);
    assert.deepEqual(selectedCourseBlockIds(selection), ['record', 'middle', 'image']);
    assert.equal(selection.content().openStart, 0);
    assert.equal(selection.content().openEnd, 0);
    assert.equal(selection.content().content.child(1).lastChild!.firstChild!.attrs.id, 'child');
  }
  assert.deepEqual(selectedCourseBlockIds(createCourseBlockSelection(doc, 'before', 'record')), ['before', 'record']);
  assert.deepEqual(selectedCourseBlockIds(createCourseBlockSelection(doc, 'image', 'after')), ['image', 'after']);
});

test('单个引用使用完整节点选区，拒绝跨父级或失效标识', () => {
  const doc = document(block('parent', 'paragraph', [block('child')]), block('record', 'courseRecord'));
  const selection = createCourseBlockSelection(doc, 'record');
  assert.ok(selection instanceof NodeSelection);
  assert.deepEqual(selectedCourseBlockIds(selection), ['record']);
  assert.throws(() => createCourseBlockSelection(doc, 'child', 'record'), /同一层级/);
  assert.throws(() => createCourseBlockSelection(doc, 'missing', 'record'), /不存在/);
  assert.deepEqual(selectedCourseBlockIds(NodeSelection.create(doc, position(doc, 'record') + 1)), ['record']);
});

test('跨段文字选区按拖动范围扩为完整块，跨嵌套时父子不重复计数', () => {
  const doc = document(block('parent', 'paragraph', [block('nested-a'), block('nested-b')]), block('next'), block('after'));
  const select = (first: string, last: string) => TextSelection.create(doc, position(doc, first) + 2, position(doc, last) + 3);
  assert.deepEqual(selectedCourseBlockIds(select('nested-a', 'nested-b')), ['nested-a', 'nested-b']);
  assert.deepEqual(selectedCourseBlockIds(select('nested-a', 'next')), ['parent', 'next']);
  assert.deepEqual(selectedCourseBlockIds(select('next', 'nested-a')), ['parent', 'next']);
  assert.deepEqual(selectedCourseBlockIds(TextSelection.create(doc, position(doc, 'next') + 2)), []);
});

test('完整块范围支持JSON、书签及外部插入后的映射，撤销所需身份不丢失', () => {
  const doc = document(block('a'), block('b', 'courseRecord'), block('c', 'image'));
  const selection = createCourseBlockSelection(doc, 'a', 'b');
  assert.ok(Selection.fromJSON(doc, selection.toJSON()).eq(selection));
  assert.ok(selection.getBookmark().resolve(doc).eq(selection));
  assert.throws(() => WholeBlockSelection.fromJSON(doc, { anchor: 'bad', head: 10 }), /格式无效/);
  const tr = EditorState.create({ doc, selection }).tr.insert(selection.from, block('inserted'));
  const mapped = selection.map(tr.doc, tr.mapping);
  assert.deepEqual(selectedCourseBlockIds(mapped), ['a', 'b']);
  assert.deepEqual(selectedCourseBlockIds(selection.getBookmark().map(tr.mapping).resolve(tr.doc)), ['a', 'b']);
});

test('删除部分选区保留完整剩余块，删除全部安全降为普通选区', () => {
  const doc = document(block('a'), block('b', 'courseRecord'), block('c', 'image'), block('after'));
  const selection = createCourseBlockSelection(doc, 'a', 'c');
  const state = EditorState.create({ doc, selection });
  const firstDeletion = state.tr.delete(position(doc, 'a'), position(doc, 'b'));
  assert.deepEqual(selectedCourseBlockIds(selection.map(firstDeletion.doc, firstDeletion.mapping)), ['b', 'c']);
  const deletion = state.tr.deleteSelection();
  assert.deepEqual(ids(deletion.doc), ['after']);
  assert.doesNotThrow(() => selection.map(deletion.doc, deletion.mapping));
  assert.doesNotThrow(() => selection.getBookmark().map(deletion.mapping).resolve(deletion.doc));
  assert.ok(!(selection.map(deletion.doc, deletion.mapping) instanceof WholeBlockSelection));
});

test('模拟原生drop的删除再插入：整体移动保持记录、子树与顺序，不复制邻块', () => {
  const doc = document(block('before'), block('record', 'courseRecord'), block('text', 'paragraph', [block('nested')]), block('image', 'image'), block('after'));
  const selection = createCourseBlockSelection(doc, 'record', 'image');
  const state = EditorState.create({ doc, selection });
  const destination = position(doc, 'after') + doc.firstChild!.lastChild!.nodeSize;
  const tr = state.tr.deleteSelection();
  tr.replaceRange(tr.mapping.map(destination), tr.mapping.map(destination), selection.content());
  assert.deepEqual(ids(tr.doc), ['before', 'after', 'record', 'text', 'image']);
  assert.equal(tr.doc.firstChild!.child(3).lastChild!.firstChild!.attrs.id, 'nested');
});
