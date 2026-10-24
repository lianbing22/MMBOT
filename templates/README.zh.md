# MMBOT 行业模板库

每个模板是一支**开箱即用的 Bot 团队**：Bot 名字、职责、可直接使用的中文提示词、群聊编成和起步指令。当前提供三套：

| 模板 | 行业 | 适用场景 |
| --- | --- | --- |
| [medical-followup.json](medical-followup.json) | 医疗 | 术后/慢病随访：计划、话术、结果回收、周报 |
| [order-delivery.json](order-delivery.json) | 制造业订单交付 | 合同评审 → 排产 → 物流 → 客户通知的全链路协同 |
| [manufacturing-inspection.json](manufacturing-inspection.json) | 制造现场管理 | 设备点检、安全巡查、质量抽检、异常闭环 |

## 三分钟落地一个模板

1. **建团队**：在 MMBOT 里按模板的 `bots` 逐个创建 Bot（设置 → Bot 团队 → 新建），名字照抄，角色填 `role`，提示词整段粘贴 `instructions`。第一个 Bot 建议选成 Main Bot（即模板里的「主管」）。
2. **建群**：按 `groups` 建群聊，把 `members` 里的 Bot 拉进来，群名照抄。
3. **起步**：把 `starterPrompts` 里第一条发给主管 Bot，团队就转起来了。

## 模板格式

```json
{
  "name": "团队名", "industry": "行业", "description": "一句话说明",
  "bots":  [{ "name": "…", "role": "…", "instructions": "…（≥120 字，可直接使用）", "model": "可选" }],
  "groups": [{ "name": "群名", "members": ["Bot 名…"], "purpose": "群的用途" }],
  "starterPrompts": ["起步指令…"]
}
```

约束（`node scripts/check-templates.mjs` 会校验）：Bot 名唯一且被群成员正确引用；`instructions` 至少 120 字；`starterPrompts` 非空。新增模板放进本目录即可被扫描。

## 自定义建议

- **模型**：给重计算的 Bot（排产、周报）指定更强模型，其余用默认。
- **提示词**：把文中的阈值（如温升 20%、AQL 1.5、血糖 16.7）换成企业自己的工艺与院感标准，这是最值得改的部分。
- **边界条款**：每个 Bot 的「边界」段落写明了它不能做什么（不改医嘱、不承诺交期、不替人拍板停线）。改写时保留这类条款，能显著降低越权输出。
