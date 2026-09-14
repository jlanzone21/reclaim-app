/**
 * Minimal dependency-free SVG chart helpers for the Insights view.
 * Deliberately small — this is scaffolding for a future ML/analytics
 * feature, not a charting library.
 */
const Charts = (function () {
  const NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  /**
   * Grouped/stacked-style bar chart. `data` is [{label, values: [{value, colorVar}]}].
   * Bars for the same label are drawn side by side.
   */
  function renderGroupedBars(container, data, opts) {
    container.innerHTML = "";
    const width = container.clientWidth || 600;
    const height = opts.height || 180;
    const padding = { top: 10, right: 10, bottom: 28, left: 10 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });

    if (!data.length) {
      const text = svgEl("text", {
        x: width / 2,
        y: height / 2,
        "text-anchor": "middle",
        class: "chart-empty-text",
      });
      text.textContent = opts.emptyText || "Nothing logged yet";
      svg.appendChild(text);
      container.appendChild(svg);
      return;
    }

    const maxVal = Math.max(1, ...data.flatMap((d) => d.values.map((v) => v.value)));
    const groupW = plotW / data.length;
    const seriesCount = data[0].values.length;
    const barGap = 3;
    const barW = Math.max(4, (groupW - 12) / seriesCount - barGap);

    data.forEach((group, gi) => {
      const groupX = padding.left + gi * groupW + 6;
      group.values.forEach((v, vi) => {
        const barH = (v.value / maxVal) * plotH;
        const x = groupX + vi * (barW + barGap);
        const y = padding.top + plotH - barH;
        svg.appendChild(
          svgEl("rect", {
            x,
            y,
            width: barW,
            height: Math.max(barH, v.value > 0 ? 2 : 0),
            rx: 2,
            fill: `var(${v.colorVar})`,
          })
        );
      });
      const label = svgEl("text", {
        x: groupX + (groupW - 12) / 2,
        y: height - 8,
        "text-anchor": "middle",
        class: "chart-axis-text",
      });
      label.textContent = group.label;
      svg.appendChild(label);
    });

    container.appendChild(svg);
  }

  /** Horizontal bar chart. `data` is [{label, value}], sorted desc by caller if desired. */
  function renderHorizontalBars(container, data, opts) {
    container.innerHTML = "";
    const width = container.clientWidth || 600;
    const rowH = opts.rowHeight || 26;
    const height = Math.max(rowH, data.length * rowH) + 8;
    const labelW = opts.labelWidth || 160;
    const plotW = width - labelW - 46;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}` });

    if (!data.length) {
      const text = svgEl("text", {
        x: width / 2,
        y: height / 2,
        "text-anchor": "middle",
        class: "chart-empty-text",
      });
      text.textContent = opts.emptyText || "Nothing logged yet";
      svg.appendChild(text);
      container.appendChild(svg);
      return;
    }

    const maxVal = Math.max(1, ...data.map((d) => d.value));

    data.forEach((d, i) => {
      const y = i * rowH + 4;
      const barW = (d.value / maxVal) * plotW;

      const label = svgEl("text", {
        x: labelW - 8,
        y: y + rowH / 2 + 4,
        "text-anchor": "end",
        class: "chart-axis-text",
      });
      label.textContent = d.label;
      svg.appendChild(label);

      svg.appendChild(
        svgEl("rect", {
          x: labelW,
          y: y,
          width: Math.max(barW, d.value > 0 ? 3 : 0),
          height: rowH - 8,
          rx: 3,
          fill: opts.colorVar ? `var(${opts.colorVar})` : "var(--accent)",
        })
      );

      const valueLabel = svgEl("text", {
        x: labelW + barW + 6,
        y: y + rowH / 2 + 4,
        class: "chart-value-text",
      });
      valueLabel.textContent = d.value;
      svg.appendChild(valueLabel);
    });

    container.appendChild(svg);
  }

  return { renderGroupedBars, renderHorizontalBars };
})();
