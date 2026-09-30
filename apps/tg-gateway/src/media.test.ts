import { composeInboundText, type InboundMedia } from "./media";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const photo: InboundMedia = {
  buffer: Buffer.from("x"),
  contentType: "image/jpeg",
  filename: "photo.jpg",
  kind: "photo",
};

const withOcr = composeInboundText({
  caption: "инвойс",
  media: photo,
  extracted: "Сумма 12000 USD, вес 15 кг",
});
assert(withOcr.includes("Клиент прислал фото"), "photo label");
assert(withOcr.includes("Подпись: инвойс"), "caption kept");
assert(withOcr.includes("12000 USD"), "ocr text");

const noOcr = composeInboundText({ caption: "", media: photo, extracted: null });
assert(noOcr.includes("Распознать содержимое не удалось"), "ocr miss fallback");
assert(!noOcr.includes("Подпись:"), "no empty caption line");

const textOnly = composeInboundText({ caption: "привет" });
assert(textOnly === "привет", "text-only passthrough");

const voice: InboundMedia = {
  buffer: Buffer.from("x"),
  contentType: "audio/ogg",
  filename: "voice.ogg",
  kind: "voice",
};
const voiced = composeInboundText({
  caption: "",
  media: voice,
  extracted: "Нужна сборка из Новосибирска в Москву",
});
assert(voiced.includes("голосовое сообщение"), "voice label");
assert(voiced.includes("Расшифровка речи"), "transcript prefix");
assert(voiced.includes("Новосибирска"), "transcript text");

const voiceMiss = composeInboundText({ caption: "", media: voice, extracted: null });
assert(voiceMiss.includes("Не удалось распознать речь"), "voice miss fallback");

const word: InboundMedia = {
  buffer: Buffer.from("x"),
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "spec.docx",
  kind: "word",
};
const worded = composeInboundText({
  caption: "",
  media: word,
  extracted: "Инвойс 8000 USD, 120 кг",
});
assert(worded.includes("документ Word"), "word label");
assert(worded.includes("8000 USD"), "word contents");

const excel: InboundMedia = {
  buffer: Buffer.from("x"),
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  filename: "cargo.xlsx",
  kind: "excel",
};
const excelled = composeInboundText({
  caption: "спека",
  media: excel,
  extracted: "Guangzhou; Moscow; 2.4 CBM",
});
assert(excelled.includes("таблицу Excel"), "excel label");
assert(excelled.includes("2.4 CBM"), "excel contents");

import { classifyOfficeFile } from "@alo/shared";
assert(classifyOfficeFile("spec.docx") === "word", "classify docx");
assert(classifyOfficeFile("cargo.xls") === "excel", "classify xls");
assert(classifyOfficeFile("invoice.xlsx", "application/vnd.ms-excel") === "excel", "classify xlsx mime");

console.log("media.test ok");
