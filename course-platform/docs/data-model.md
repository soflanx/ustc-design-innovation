# 数据模型

演示账号、人物、小组、新闻与项目均为虚构。seed 使用稳定 ID，只创建缺失记录；重跑不清空业务数据或覆盖教师编辑，不生成学生成绩。

Course 是长期课程，Term 是学期，CourseOffering 是课程在学期中的开课。CourseStaff 仅保存长期教师负责人，应用创建开课时将其带入 CourseMember。User 跨学期；isAdmin 独立于教学角色，教学角色不授予代码部署权限。isDemo 标识本地演示白名单。

CourseMember 每开课每用户唯一。Group 每开课名称唯一。GroupMember 与 TaGroupAssignment 保存历史，以 leftAt/endedAt 关闭记录。当前假设一个学生每次开课仅一个活跃组，partial unique index 落实。每组可有多名助教，同一组/助教仅一个活跃分配。小组成员须为 STUDENT，助教分配须为 TA。已有学业记录的成员不可直接改角色；已有提交的作业不可改模式。

开课范围内的关系使用 (id, offeringId) 复合外键，防止跨期开课引用：组员、助教分配、作业提交、版本、提交者、参与者、评阅、成绩、历史、文件附件、小组页面和教学笔记作者。TeachingNote 必须有同开课作者 courseMemberId，内部教学笔记由服务端限制可见性。

Assignment 区分个人/小组，Submission 的 courseMemberId/groupId 必须且只能填一项，且与作业模式相符。每作业每个人/小组仅一个提交容器。SubmissionVersion 按容器版本号唯一；submittedById 记录实际提交者，finalizedAt 表示正式封存。封存前可在事务内组装参与者快照及附件；封存后版本禁止改删、参与者和附件禁止增改删。关联变更先锁版本行，避免与封存并发穿透。Review 必须指向封存版本。

GradeRecord 每作业每学生唯一，含 DRAFT/PUBLISHED、publishedAt、reviewId、updatedById。数据库验证发布状态与时间一致、成绩对象为 STUDENT、评阅者和改分者为 TEACHER/TA、评阅来源与作业和学生版本快照匹配。GradeHistory 保存 actorId、recordedAt、reason、previousScore、score 和 status，禁止改删。服务端必须在同一事务写当前成绩和历史；数据库未自动生成历史或核对前后分数。分数使用 Decimal(8,2)，不实现尚未确定的总评算法。

FileObject 保存 offeringId；SubmissionFile 以复合外键关联同开课版本与文件。文件所有权、上传及读取权限仍待服务端实现；当前提交仅支持正文。助教分组是职责分工，当前授权允许其阅读与反馈本期全部提交。

Post、Resource、GroupPage 显式保存发布状态和 visibility。PUBLIC 可公开展示；OFFERING 需服务端验证成员权限，枚举不自动提供行级权限。Post 可无开课，此时必须 PUBLIC。Resource 服务固定写入 OFFERING，仅教师或管理员管理；其他有效课程成员仅看 PUBLISHED，归档开课拒绝全部写入。

AuthSession 仅保存随机 token 哈希、用户、有效期；原始随机 token 放 opaque cookie，并非签名 cookie。

CourseFocus 每期开课最多一份，保存教学团队自由编辑的当前标题与正文，不表示固定教学阶段或完整课表。CourseFocusAssignment、CourseFocusResource 按开课范围关联作业与资料，复合外键拒绝跨期引用。教师、助教或管理员可编辑，归档后只读；保存正文及关联在同一事务内替换。读取继续沿用原记录的可见性：学生可读已发布或已结束作业及已发布资料，不能通过关联读到草稿。助教编辑时保留其不可见的草稿/下架资料关联，避免修改正文时意外删除教师配置。

Prisma 7 的 datasource URL 由 prisma.config.ts 提供。初始迁移从空库 diff 生成，再加入 CHECK、partial unique indexes 和触发器，不能以 db push 替代。数据库规则不替代服务端授权。参与者学生身份、提交者是否有该提交归属的权限、封存时快照是否完整仍须服务端事务验证。

后续迁移 `20261018010000_history_guards` 固定 Review 的 offeringId、versionId、reviewerId，建立后不能更换来源或署名，仍允许修改评语和分数。成员角色历史保护同时涵盖个人提交归属、实际提交者、评阅者、成绩改分者、历史操作者、教学笔记作者，避免事后改角色改变历史含义；无上述记录的成员仍可正常变更角色。

2026-10-20 服务层落地：`teaching.ts` 在 Serializable 事务中独立鉴权，创建提交容器、递增版本、保存有效学生快照并封存，冲突时重试完整事务。请求 UUID 同时作为版本 ID；同一作者、同一作业、相同正文的重复请求返回原版本。成功请求到期后重试不产生新记录，新的提交在服务端时间达到截止点时拒绝。归档课程始终拒绝写入。

学生历史读取按版本参与者快照过滤，个人提交还核对固定个人归属；当前组籍不授予历史访问权。列表计数、最新摘要、详情及反馈使用同一规则。教师/助教全期可读，只有有效教师/助教 CourseMember 可署名反馈，管理员权限不会伪造教学身份。当前 Review 仅写文字，score 保持空，不生成 GradeRecord。

作业发布后不可退回 DRAFT；从未发布的草稿不可直接 ARCHIVED，防止草稿通过“结束”状态泄漏。ARCHIVED 作业保留学生历史读取并停止新提交，仍可接受教学团队反馈；ARCHIVED 开课则全部只读。资料的 ARCHIVED 表示下架，对普通课程成员隐藏，两者含义分别在界面说明。

当前进度概览以有效个人/含有效学生的小组为应交对象，仅其最新封存版本参与当前统计。待反馈指此最新版没有 Review，旧版本的 Review 不抵扣；空组和退出成员的版本仍在历史中。学生 progress 额外限定当前归属和本人快照，教学 summary 与队列不返回给学生。

小组新提交要求客户端提供 expectedGroupId，并与事务内推导的真实组籍核对；该值不能选择或授予归属权限。若打开表单后调组，拒绝新写入。同一已成功 UUID 的幂等重试仍可返回原记录。浏览器草稿单独保存旧组上下文，改变正文或明确确认新组时生成新请求 UUID；原样重试继续沿用原 UUID，避免网络中断后重复提交或陷入正文冲突。
