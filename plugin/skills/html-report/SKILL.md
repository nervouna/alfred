---
name: html-report
description: Build a self-contained HTML report with inline-SVG charts and tables that reads on the workbench and renders to PDF with render_pdf. Use for any report with charts, wide tables or a formal layout.
---

# HTML report

Write one self-contained `.html` file where the workspace rules put deliverables. It has to work in two places that both block the network: the workbench's sandboxed viewer, and `render_pdf`, which also runs no JavaScript and adds A4 margins and page numbers itself.

## Rules

- Everything inline: CSS in `<style>`, charts as inline `<svg>`. No `<script>`, no web fonts, no CDN, no `http(s)` URL except in `<a href>`.
- Images only from the workspace, by path relative to the report, e.g. `../images/<date>/cover.jpg` from `reports/`.
- Keep the template's font stack: it covers Chinese on the server.
- Draw every chart yourself from the data: compute the coordinates with the formula in the snippet's comment. Every `<svg>` has a `<title>`, axis labels with units, and a `<figcaption>` that names the source.
- Language: Simplified Chinese unless the user asks otherwise.
- Keep `<meta name="generator" content="alfred:html-report">`.

## Template

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="generator" content="alfred:html-report">
<title>报告标题</title>
<style>
html { font-size: 10.5pt; }
body { margin: 0 auto; max-width: 820px; padding: 24px 16px; color: #1f2328; line-height: 1.7;
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
@media print { body { max-width: none; padding: 0; } }
h1 { font-size: 1.8em; margin: 0 0 .2em; }
h2 { font-size: 1.35em; margin: 1.6em 0 .6em; padding-bottom: .25em; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 1.1em; margin: 1.2em 0 .4em; }
h1, h2, h3 { break-after: avoid; }
.meta { color: #59636e; margin: 0 0 1.5em; }
.summary { background: #f6f8fa; border-radius: 8px; padding: .2em 1.2em .6em; }
a { color: #0969da; text-decoration: none; overflow-wrap: anywhere; }
figure { margin: 1.2em 0; break-inside: avoid; }
figcaption { color: #59636e; font-size: .9em; margin-top: .4em; }
svg { display: block; width: 100%; height: auto; }
svg text { font-family: inherit; font-size: 12px; fill: #1f2328; }
svg .axis line { stroke: #8c959f; }
svg .grid line { stroke: #eaeef2; }
svg .muted { fill: #59636e; }
svg .in { fill: #fff; }
.c1 { fill: #2f6fdf; } .c2 { fill: #e8833a; } .c3 { fill: #3a9d5d; } .c4 { fill: #9a5fd0; }
.l1 { stroke: #2f6fdf; } .l2 { stroke: #e8833a; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .92em; margin: 0 0 1em; }
th, td { border: 1px solid #d0d7de; padding: .4em .6em; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr { break-inside: avoid; }
table.wide { font-size: .8em; }
table.wide th { white-space: nowrap; }
.sources { font-size: .9em; }
</style>
</head>
<body>
<h1>报告标题</h1>
<p class="meta">2026-10-25 · Alfred</p>

<section class="summary">
<h2>摘要</h2>
<ul>
<li>结论一，带关键数字。</li>
</ul>
</section>

<h2>第一部分</h2>
<p>正文。</p>
<!-- charts and tables from the snippets below -->

<section class="sources">
<h2>来源</h2>
<ol>
<li><a href="https://example.com/a">页面标题</a>，网站名，发布日期或访问日期</li>
</ol>
</section>
</body>
</html>
```

## Snippets

Bar chart. Plot area x 60–620, y 20–280; for a scale 0–max, `y(v) = 280 - v * 260 / max` and bar height `v * 260 / max`. With n bars each slot is `560 / n` wide.

```html
<figure>
<svg viewBox="0 0 640 310" role="img" aria-labelledby="fig1">
<title id="fig1">2026 年各季度营收（亿元）</title>
<g class="grid"><line x1="60" y1="150" x2="620" y2="150"/><line x1="60" y1="20" x2="620" y2="20"/></g>
<g class="axis"><line x1="60" y1="280" x2="620" y2="280"/><line x1="60" y1="20" x2="60" y2="280"/></g>
<g class="muted" text-anchor="end"><text x="52" y="284">0</text><text x="52" y="154">50</text><text x="52" y="24">100</text></g>
<g class="c1">
<rect x="90" y="124" width="80" height="156"/><rect x="230" y="92.8" width="80" height="187.2"/>
<rect x="370" y="137" width="80" height="143"/><rect x="510" y="51.2" width="80" height="228.8"/>
</g>
<g text-anchor="middle">
<text x="130" y="118">60</text><text x="270" y="86.8">72</text><text x="410" y="131">55</text><text x="550" y="45.2">88</text>
<text x="130" y="300">Q1</text><text x="270" y="300">Q2</text><text x="410" y="300">Q3</text><text x="550" y="300">Q4</text>
</g>
</svg>
<figcaption>图 1　各季度营收。来源：公司财报。</figcaption>
</figure>
```

Line chart, two series with a legend. Same plot area; with n points `x(i) = 60 + i * 560 / (n - 1)`.

```html
<figure>
<svg viewBox="0 0 640 310" role="img" aria-labelledby="fig2">
<title id="fig2">月活跃用户（万）</title>
<g class="grid"><line x1="60" y1="150" x2="620" y2="150"/><line x1="60" y1="20" x2="620" y2="20"/></g>
<g class="axis"><line x1="60" y1="280" x2="620" y2="280"/><line x1="60" y1="20" x2="60" y2="280"/></g>
<g class="muted" text-anchor="end"><text x="52" y="284">0</text><text x="52" y="154">100</text><text x="52" y="24">200</text></g>
<polyline class="l1" fill="none" stroke-width="2.5" points="60,176 172,156.5 284,137 396,143.5 508,111 620,72"/>
<polyline class="l2" fill="none" stroke-width="2.5" points="60,202 172,189 284,195.5 396,163 508,150 620,124"/>
<g text-anchor="middle" class="muted">
<text x="60" y="300">1月</text><text x="172" y="300">2月</text><text x="284" y="300">3月</text>
<text x="396" y="300">4月</text><text x="508" y="300">5月</text><text x="620" y="300">6月</text>
</g>
<g><rect class="c1" x="440" y="30" width="14" height="4"/><text x="460" y="36">产品 A</text>
<rect class="c2" x="530" y="30" width="14" height="4"/><text x="550" y="36">产品 B</text></g>
</svg>
<figcaption>图 2　月活跃用户。来源：……</figcaption>
</figure>
```

Stacked horizontal bars for shares that add up to 100%. Plot x 120–620, so a share of p% is `p * 5` wide; each segment starts where the previous one ends.

```html
<figure>
<svg viewBox="0 0 640 170" role="img" aria-labelledby="fig3">
<title id="fig3">收入构成（%）</title>
<g text-anchor="end"><text x="110" y="51">产品 A</text><text x="110" y="101">产品 B</text></g>
<rect class="c1" x="120" y="30" width="225" height="32"/><rect class="c2" x="345" y="30" width="175" height="32"/><rect class="c3" x="520" y="30" width="100" height="32"/>
<rect class="c1" x="120" y="80" width="150" height="32"/><rect class="c2" x="270" y="80" width="250" height="32"/><rect class="c3" x="520" y="80" width="100" height="32"/>
<g class="in" text-anchor="middle">
<text x="232.5" y="51">45%</text><text x="432.5" y="51">35%</text><text x="570" y="51">20%</text>
<text x="195" y="101">30%</text><text x="395" y="101">50%</text><text x="570" y="101">20%</text>
</g>
<g><rect class="c1" x="120" y="140" width="12" height="12"/><text x="138" y="151">订阅</text>
<rect class="c2" x="200" y="140" width="12" height="12"/><text x="218" y="151">硬件</text>
<rect class="c3" x="280" y="140" width="12" height="12"/><text x="298" y="151">服务</text></g>
</svg>
<figcaption>图 3　收入构成。来源：……</figcaption>
</figure>
```

Wide table: numbers right-aligned, headers kept on one line. Beyond about eight columns, split it into two tables.

```html
<div class="table-wrap">
<table class="wide">
<thead><tr><th>方案</th><th class="num">月费（元）</th><th class="num">CPU</th><th class="num">内存（GB）</th><th>地区</th><th>来源</th></tr></thead>
<tbody>
<tr><td>方案 A</td><td class="num">35</td><td class="num">2</td><td class="num">4</td><td>香港</td><td><a href="https://example.com/a">官网</a></td></tr>
</tbody>
</table>
</div>
```

## Before delivering

- The `<title>`, the `<h1>` and the date line name the topic and when it was written.
- The summary comes first: three to five bullets that answer the question, with the key numbers.
- Numbers in charts, tables and text agree.
- No `<script>` and no network URL outside links; images load by relative workspace path.
- The sources section lists every source with its link and date.
- Deliver as the system prompt says. When a PDF is wanted, render it with `render_pdf` and Read the PDF to check that the charts and tables survived.
