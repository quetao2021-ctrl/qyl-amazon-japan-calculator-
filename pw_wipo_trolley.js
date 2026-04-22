async (page) => {
  await page.locator('#PROD_input').fill('trolley');
  await page.click('#design_search .searchButton');
  await page.waitForTimeout(3500);
  const info = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="row"]')].slice(1,20);
    const parsed = rows.map(r => {
      const cells = [...r.querySelectorAll('[role="gridcell"], td')].map(c => (c.textContent||'').trim());
      return {text:(r.textContent||'').trim(), cells};
    }).filter(x=>x.cells.length>=7 || /DM\//.test(x.text));
    const countText = document.querySelector('.resultInfo,.resultsInfo,.rowsInfo,.gridInfo')?.textContent || '';
    return {url:location.href, rowCount:parsed.length, countText, sample:parsed.slice(0,10)};
  });
  return info;
}
