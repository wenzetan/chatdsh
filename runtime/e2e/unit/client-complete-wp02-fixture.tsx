import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog, ErrorSummary, Field, ProgressBar, ScrollRegion, Tabs, Toast } from '../../packages/core/ui-kit/src/index.ts';

function ComponentExercise() {
  const [open, setOpen] = useState(false);
  const [selected, select] = useState('first');
  const [message, setMessage] = useState('等待操作');
  return <main><h1>共享组件交互验证</h1>
    <ErrorSummary errors={[{ fieldId: 'project-name', message: '项目名称不能为空' }]} />
    <Field label="项目名称" help="输入项目的显示名称" error="请输入名称" required><input id="project-name" /></Field>
    <Tabs label="项目设置" selectedId={selected} onSelect={select} items={[
      { id: 'first', label: '基本设置', content: '基本设置内容' },
      { id: 'disabled', label: '受限设置', disabledReason: '权限不足', content: '不可用内容' },
      { id: 'second', label: '高级设置', content: '高级设置内容' },
    ]} />
    <Button id="open-dialog" onClick={() => setOpen(true)}>打开确认对话框</Button>
    <Dialog open={open} title="确认项目" description="检查名称后提交" onClose={() => setOpen(false)}>
      <Field label="确认名称"><input id="confirm-name" /></Field>
      <Button id="confirm-dialog" onClick={() => { setMessage('已确认项目'); setOpen(false); }}>确认</Button>
    </Dialog>
    <ProgressBar label="读取进度" ratio={0.4} />
    <Toast>{message}</Toast>
    <ScrollRegion label="完整记录"><table><caption>字段记录</caption><thead><tr><th scope="col">名称</th><th scope="col">内容</th></tr></thead>
      <tbody><tr><th scope="row">路径</th><td>{'/long/'.repeat(30)}</td></tr></tbody></table></ScrollRegion>
  </main>;
}

createRoot(document.getElementById('root')!).render(<ComponentExercise />);
