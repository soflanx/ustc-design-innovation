type ResourceValues = { id: string; title: string; body: string; url: string | null; status: string };

export function ResourceFields({ resource }: { resource?: ResourceValues }) {
  const suffix = resource?.id || 'new';
  return <>
    <div className="form-field"><label htmlFor={`resource-title-${suffix}`}>资料标题</label><input id={`resource-title-${suffix}`} name="title" required maxLength={100} defaultValue={resource?.title}/></div>
    <div className="form-field"><label htmlFor={`resource-body-${suffix}`}>资料说明</label><textarea id={`resource-body-${suffix}`} name="body" rows={9} maxLength={12000} defaultValue={resource?.body}/></div>
    <div className="form-field"><label htmlFor={`resource-url-${suffix}`}>资料链接</label><input id={`resource-url-${suffix}`} name="url" type="url" placeholder="https://" maxLength={2000} defaultValue={resource?.url || ''}/><p className="field-help">资料说明和链接至少填写一项。外部文档的访问权限需在原平台设置。</p></div>
    <div className="form-field"><label htmlFor={`resource-status-${suffix}`}>发布状态</label><select id={`resource-status-${suffix}`} name="status" defaultValue={resource?.status || 'DRAFT'}><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已下架</option></select><p className="field-help">只有本期课程成员可以查看已发布资料。</p></div>
  </>;
}
