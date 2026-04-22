async (page) => {
  await page.goto('https://designdb.wipo.int/designdb/hague/en/');
  await page.waitForTimeout(2500);
  await page.locator('#PROD_input').fill('foldable crate');
  await page.click('#design_search .searchButton');
  await page.waitForTimeout(3500);
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="row"]')].filter(r => /DM\/\d+/.test(r.textContent||''));
    const data = rows.map(r => {
      const text = (r.textContent||'').replace(/\s+/g,' ').trim();
      const dm = (text.match(/DM\/\d+/)||[])[0]||null;
      const reg = (text.match(/HAGUE\.D\d+/)||[])[0]||null;
      const date = (text.match(/20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2}/)||[])[0]||null;
      const img = r.querySelector('img')?.getAttribute('src') || null;
      return {dm,reg,date,text,imageUrl: img ? (img.startsWith('//') ? ('https:' + img) : img) : null};
    });
    return {rowCount:data.length, first:data[0] || null};
  });
}
