import Database from "better-sqlite3";

export function readObjectiveDatabase(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const entityRows = db.prepare("SELECT state_json FROM entity ORDER BY id").all();
    if (entityRows.length !== 1) throw new Error(`expected exactly one entity row, found ${entityRows.length}`);
    let state;
    try {
      state = JSON.parse(entityRows[0].state_json);
    } catch (error) {
      throw new Error(`entity.state_json is malformed: ${error.message}`);
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("entity.state_json is not an object");
    const events = db.prepare("SELECT payload_json FROM events ORDER BY seq").all().map((row, index) => {
      try {
        return JSON.parse(row.payload_json);
      } catch (error) {
        throw new Error(`events row ${index + 1} has malformed payload_json: ${error.message}`);
      }
    });
    return { state, events };
  } finally {
    db.close();
  }
}
