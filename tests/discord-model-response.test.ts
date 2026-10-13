import { expect, test } from "bun:test";
import { parseModelObject, parseRelevanceResponse } from "../extensions/discord/model-response";

test("accepts complete fenced model JSON while rejecting truncated or invalid evidence", () => {
  expect(parseRelevanceResponse(' \n```JSON\n{"score":0.9,"reason":"Useful","participantIds":["123"]}\n```\n'))
    .toEqual({ score: 0.9, reason: "Useful", participantIds: ["123"] });
  expect(parseModelObject('```json\n{"topics":["SQLite"]}\n```')).toEqual({ topics: ["SQLite"] });
  for (const raw of ['{"score":0.9', '[{}]', '{"score":2,"reason":"Invalid","participantIds":[]}',
    '{"score":0.9,"reason":"Invalid","participantIds":[123]}']) expect(() => parseRelevanceResponse(raw)).toThrow();
});
