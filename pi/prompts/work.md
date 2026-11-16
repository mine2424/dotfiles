---
description: pstackで依頼を分類し、必要なPlaybookへ進む互換入口
argument-hint: "<依頼・受入条件>"
---
依頼: $ARGUMENTS

pstackのpoteto-mode Skill本体と共通PRINCIPLES.mdを読み、依頼を分類する。
新規開発はnew-development、既存改修はexisting-change、障害はincident-fixを読む。
分類に応じてpstackのPlaybookと専門Skillを選び、状況から得た事実に応じて進め方を変更する。
これは互換Promptで、拡張のstickyモードを切り替えるものではない。通常は /poteto-mode <依頼> を入口にする。
