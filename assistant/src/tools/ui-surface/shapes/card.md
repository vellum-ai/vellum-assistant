# card

structured info card, supports templates like task_progress

```
{ title, subtitle?, body, metadata?: [{ label, value }], template?, templateData? }. Template "task_progress" renders a live step tracker — templateData: { title, status: "pending"|"in_progress"|"completed"|"failed", steps: [{ label, status: "pending"|"in_progress"|"completed"|"failed", detail? }] }; advance it via ui_update as steps finish. Other card templates are documented by the skills that use them
```
