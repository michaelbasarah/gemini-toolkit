// Writes demo/sample-menu.pdf: a bill of fare in the style of an 1890s hotel menu. The text is original
// to this repo (not copied from any restaurant). It has dotted leaders, a price range, a per-unit price,
// a market-price line and one dish with no price, so there is something for the reviewer flags to catch.
// Zero dependencies: a hand-built single-page PDF with the built-in Courier font.
import { writeFileSync } from "node:fs";

const W = 56; // characters per line at 10pt Courier
const row = (name, price) => (price ? name + " " + ".".repeat(Math.max(2, W - name.length - price.length - 2)) + " " + price : name);
const centre = (s) => " ".repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s;

const lines = [
  centre("THE RIVERSIDE HOTEL"),
  centre("BILL OF FARE"),
  centre("(sample menu written for this repo)"),
  "",
  "SOUPS",
  row("Consomme, with vegetables", "$0.35"),
  row("Oyster stew", "$0.50"),
  row("Cream of asparagus", "$0.30"),
  "",
  "FISH",
  row("Boiled salmon, egg sauce", "$0.60"),
  row("Fried smelts, tartar sauce", "$0.45"),
  row("Baked whitefish", "market price"),
  "",
  "ROASTS",
  row("Prime ribs of beef, au jus", "$0.75-$1.10"),
  row("Spring lamb, mint sauce", "$0.70"),
  row("Roast turkey, cranberry", "$0.65"),
  "",
  "VEGETABLES (per dish)",
  row("Mashed potatoes", "$0.10/dish"),
  row("Stewed tomatoes", "$0.10/dish"),
  row("Green peas", "$0.15/dish"),
  "",
  "PASTRY AND DESSERT",
  row("Apple pie", "$0.15"),
  row("Charlotte russe", "$0.20"),
  row("Vanilla ice cream", ""),
  row("Coffee, tea or milk", "$0.05"),
  "",
  centre("Gentlemen are requested to report any"),
  centre("neglect on the part of the waiters."),
];

const esc = (s) => s.replace(/[\\()]/g, "\\$&");
let y = 760;
let stream = "BT /F1 10 Tf 12 TL 56 " + y + " Td\n";
for (const l of lines) stream += `(${esc(l)}) Tj T*\n`;
stream += "ET";

const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL("../demo/sample-menu.pdf", import.meta.url), pdf);
console.log("wrote demo/sample-menu.pdf");
