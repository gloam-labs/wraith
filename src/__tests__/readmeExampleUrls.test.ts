import fs from "fs";
import path from "path";

describe("README.md example URLs", () => {
  it("guards against shortened or invalid addresses in example URLs", () => {
    const readmePath = path.resolve(__dirname, "../../README.md");
    expect(fs.existsSync(readmePath)).toBe(true);

    const content = fs.readFileSync(readmePath, "utf-8");

    // Match all http, https, and ws URLs in README
    const urlRegex = /(?:https?|ws):\/\/[^\s"'`<>)]+/g;
    const urls = content.match(urlRegex) ?? [];

    expect(urls.length).toBeGreaterThan(0);

    const violations: { url: string; segment: string; reason: string }[] = [];

    for (const urlStr of urls) {
      try {
        const parsed = new URL(urlStr);
        const segments = parsed.pathname.split("/").filter(Boolean);

        for (const rawSegment of segments) {
          const segment = decodeURIComponent(rawSegment);
          // Check path segments that look like an address (starts with G or C)
          // Exclude known endpoints/route names such as "candles"
          if (/^[GC][A-Za-z0-9_….-]+$/.test(segment) && segment !== "candles") {
            if (segment.length !== 56) {
              violations.push({
                url: urlStr,
                segment,
                reason: `Address segment "${segment}" has length ${segment.length}, expected 56`,
              });
            } else if (!/^[GC][A-Z2-7]{55}$/.test(segment)) {
              violations.push({
                url: urlStr,
                segment,
                reason: `Address segment "${segment}" is not a valid Stellar address/contract format`,
              });
            }
          }
        }

        // Also check query parameters that look like an address or contract ID
        parsed.searchParams.forEach((rawVal, key) => {
          const val = decodeURIComponent(rawVal);
          if ((key === "address" || key === "contractId") && /^[GC][A-Za-z0-9_….-]+$/.test(val)) {
            if (val.length !== 56) {
              violations.push({
                url: urlStr,
                segment: `${key}=${val}`,
                reason: `Query param "${key}=${val}" has length ${val.length}, expected 56`,
              });
            }
          }
        });
      } catch {
        // Ignore unparseable URLs if any
      }
    }

    expect(violations).toEqual([]);
  });
});
