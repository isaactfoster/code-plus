import { describe, expect, it } from "vite-plus/test";

import {
  isMuseSkillCatalogEntry,
  mapMuseSkillCatalog,
  museSkillPath,
} from "./MuseSkills.ts";

describe("mapMuseSkillCatalog", () => {
  it("maps selectors, descriptions, and argument hints", () => {
    const { skills, slashCommands } = mapMuseSkillCatalog([
      {
        selector: "fix-bug",
        displayName: "Fix Bug",
        description: "Fix a bug",
        argumentHint: "<file>",
        source: "bundled",
      },
    ]);
    expect(skills).toEqual([
      {
        name: "fix-bug",
        displayName: "Fix Bug",
        description: "Fix a bug",
        shortDescription: "Fix a bug",
        path: "muse://skill/fix-bug",
        scope: "bundled",
        enabled: true,
        userInvocable: true,
      },
    ]);
    expect(slashCommands).toEqual([
      { name: "fix-bug", description: "Fix a bug", input: { hint: "<file>" } },
    ]);
  });

  it("keeps plugin-qualified selectors verbatim for native skill input", () => {
    const { skills } = mapMuseSkillCatalog([
      {
        selector: "acme:deploy",
        displayName: "Deploy",
        description: "Deploy via plugin",
        source: "plugin",
        pluginId: "acme",
      },
    ]);
    expect(skills[0]?.name).toBe("acme:deploy");
    expect(skills[0]?.path).toBe("muse://skill/acme:deploy");
  });

  it("dedupes and skips blank selectors", () => {
    const { skills } = mapMuseSkillCatalog([
      { selector: "a", displayName: "A", description: "a", source: "user" },
      { selector: "a", displayName: "A2", description: "a2", source: "user" },
      { selector: "  ", displayName: "blank", description: "x", source: "user" },
    ]);
    expect(skills.map((skill) => skill.name)).toEqual(["a"]);
  });

  it("validates catalog entries and builds synthetic paths", () => {
    expect(
      isMuseSkillCatalogEntry({
        selector: "x",
        displayName: "X",
        description: "d",
        source: "project",
      }),
    ).toBe(true);
    expect(isMuseSkillCatalogEntry({ selector: "x" })).toBe(false);
    expect(museSkillPath("acme:deploy")).toBe("muse://skill/acme:deploy");
  });
});
