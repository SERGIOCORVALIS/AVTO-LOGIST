import * as XLSX from "xlsx";
import { classifyOfficeFile, extractExcelText } from "./office";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

assert(classifyOfficeFile("a.docx") === "word", "docx");
assert(classifyOfficeFile("a.doc") === "word", "doc");
assert(classifyOfficeFile("a.xlsx") === "excel", "xlsx");
assert(classifyOfficeFile("a.xls") === "excel", "xls");
assert(classifyOfficeFile("a.csv") === "excel", "csv");
assert(classifyOfficeFile("a.pdf") === null, "pdf");

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["товар", "вес_кг", "город"],
    ["powerbank", 12, "Guangzhou"],
  ]),
  "груз"
);
const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
const table = extractExcelText(buf, "cargo.xlsx");
assert(table.includes("powerbank"), "sku");
assert(table.includes("Guangzhou"), "city");

console.log("office.test ok");
