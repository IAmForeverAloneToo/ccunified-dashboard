/** The ccunified mark: three columns in the first three chart colors. */
export function logo(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "brand-mark");
  svg.setAttribute("aria-hidden", "true");
  const bars: [number, number, string][] = [
    [3, 10, "s1"],
    [10, 5, "s2"],
    [17, 13, "s3"],
  ];
  for (const [x, y, cls] of bars) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", "5");
    r.setAttribute("height", String(21 - y));
    r.setAttribute("rx", "1.5");
    r.setAttribute("class", cls);
    svg.append(r);
  }
  return svg;
}
