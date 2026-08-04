'use strict';

// 极简 CSV 读写工具，零依赖，仅供本模板内部使用。
// 支持带引号字段（内含逗号/换行/转义双引号 ""）的 RFC4180 风格解析。

/**
 * 把 CSV 文本解析为「对象数组」，第一行作为表头（key）。
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // 忽略，交给紧随其后的 \n 结束一行
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 去掉文件末尾空行留下的空行（只有一个空字符串字段）
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  if (rows.length && rows[0].length) {
    rows[0][0] = rows[0][0].replace(/^﻿/, ''); // 去 BOM
  }

  const header = rows.shift() || [];
  return rows.map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h.trim()] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

function csvField(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 把「数组的数组」序列化为 CSV 文本（每行末尾 \n）。
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
function toCSV(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

module.exports = { parseCSV, toCSV, csvField };
