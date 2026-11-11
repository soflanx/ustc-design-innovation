# USTC 设计创新课程网站

中国科学技术大学设计创新课程的网站原型，包含公开展示门户和按课程、学期、角色组织的教学协作空间。

当前应用位于 [`course-platform/`](course-platform/)，使用 Next.js、TypeScript、Prisma 和 PostgreSQL。

- **公开门户**：课程愿景、学习方式、合作交流网络、新闻、故事、课程与学期。新闻用于通知、活动报道与项目进展；故事用于人物经历、项目过程与设计思考，不限定学生或小组。
- **教学协作**：课程首页与课次编辑、学生与小组课堂记录、资料预览、作业版本与评语。
- **角色与权限**：教师、助教、学生与管理员；教学数据由服务端按课程成员关系校验。

## 本地运行

需要 Node.js 22.12+，以及 PostgreSQL 16+ 的命令行工具。首次运行：

```sh
git clone https://github.com/soflanx/ustc-design-innovation.git
cd ustc-design-innovation
cd course-platform
npm ci
npm run db:local
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

打开 <http://127.0.0.1:4174>。`db:local` 会创建本机数据库和 `.env`，这些文件不进入版本控制。已有数据库配置可参照 [`.env.example`](course-platform/.env.example) 自行设置。

## 文档与检查

- [每次改网站时的体验走查](course-platform/docs/experience-review.md)
- [应用说明、操作流程与测试命令](course-platform/README.md)
- [创建课次、写 Markdown 与插入作业和资料](course-platform/docs/course-page-editor.md)
- [界面设计约定](course-platform/DESIGN.md)
- [数据模型](course-platform/docs/data-model.md)
- [图片来源与署名](course-platform/public/images/portal/sources.json)

在 `course-platform/` 目录运行 `npm run build` 检查生产构建，运行 `npm test` 执行隔离数据库集成测试。

本站目前是教学原型。种子账号、新闻与故事为虚构样稿，图片为场景示意；教师可上传课程资料供本期成员打开或下载。正式学校认证和生产部署尚未接入。开发演示登录不会在生产模式开放。
