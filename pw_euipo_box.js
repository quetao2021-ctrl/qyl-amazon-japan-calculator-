async (page) => {
  await page.locator('#basicSearchSmallInput').fill('box');
  await page.locator('#basicSearchSmallButton').click();
  await page.waitForTimeout(4000);
  return await page.evaluate(() => {
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
}
