import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg.default ?? xlsxPkg;

export function parseMatrixFromXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  if (!firstSheet) return [];

  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  const out = [];

  for (const row of rows) {
    const atributo = String(row['Atributo'] || row['atributo'] || row['Attribute'] || row['Item'] || '' || null).trim();
    
    const categoria = String(row['Categoria'] || row['Categoría'] || row['categoria'] || row['Category'] || '' || null).trim();
    let pesoRaw = row['Peso'] ?? row['peso'] ?? row['Weight'] ?? row['valor'] ?? '';
    if (typeof pesoRaw === 'string') pesoRaw = pesoRaw.replace(',', '.').trim();
    const peso = Number(pesoRaw);
    const criterio = String(row['Criterio'] || row['criterio'] || row['Criterion'] || row['Descripción'] || '' || null).trim();
    if (!atributo || !categoria || Number.isNaN(peso) || peso < 0) continue;
    out.push({ atributo, categoria, peso, ...(criterio ? { criterio } : {}) });
  }
  return out;
}
