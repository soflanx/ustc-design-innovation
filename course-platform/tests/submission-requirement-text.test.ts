import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentMaterialLink } from '../src/lib/assignment-material-links';
import { submissionRequirementText } from '../src/lib/submission-requirement-text';

const url = 'https://example.org/原型?view=2#route';
const material = assignmentMaterialLink('term', { id: 'private-record', title: url });

test('核对要求时，只有教师粘贴的原型网址成为链接，同名资料始终是原标签', () => {
  const result = submissionRequirementText(`对照：${url}。\r\n\r\n再读${material}。`, 'term');
  assert.deepEqual(result, {
    description: `对照：${url}。\r\n\r\n再读${url}。`,
    descriptionParts: [
      { text: '对照：' }, { text: url, href: url }, { text: '。\r\n\r\n再读' }, { text: url }, { text: '。' },
    ],
  });
});

test('只有普通说明或正式资料时，确认上下文保持原有纯文字结构', () => {
  for (const description of ['', '填写观察记录。\r\n  下一步', 'javascript:alert(1)']) {
    assert.deepEqual(submissionRequirementText(description, 'term'), { description });
  }
  assert.deepEqual(submissionRequirementText(`阅读${material}`, 'term'), { description: '阅读' + url });
});
