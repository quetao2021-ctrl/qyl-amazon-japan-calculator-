async (page) => {
  const terms = [
    'folding cart',
    'trolley box',
    'wheeled storage box',
    'storage box with wheels',
    'shopping trolley',
    'luggage trolley',
    'rolling box',
    'collapsible cart',
    'foldable container'
  ];
  const out = [];
  for (const term of terms) {
    await page.locator('#basicSearchSmallInput').fill(term);
    await page.locator('#basicSearchSmallButton').click();
    await page.waitForTimeout(2500);
    const result = await page.evaluate(() => {
      const pick = (regex) => [...document.querySelectorAll('a')].find(a => regex.test(a.textContent || ''));
      const getCount = (el) => {
        if (!el) return null;
        const m = (el.textContent || '').match(/\((\d+)\)/);
        return m ? Number(m[1]) : null;
      };
      return {
        url: location.href,
        trademarks: getCount(pick(/Trade marks \(/)),
        designs: getCount(pick(/Designs \(/)),
        owners: getCount(pick(/Owners \(/)),
        reps: getCount(pick(/Representatives \(/))
      };
    });
    out.push({ term, ...result });
  }
  return out;
}
