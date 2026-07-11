import { describe, expect, it } from "vitest";
import { type CertTemplate, validateCertificate } from "../../src/parallel/certificate.js";

const template: CertTemplate = {
  sections: [{ label: "Premises" }, { label: "Conclusion" }],
};

describe("parallel certificate validation", () => {
  it("accepts every required section and reports each missing section verbatim", () => {
    expect(validateCertificate(template, {
      artifact: "## Premises\n[P1] fact\n## Conclusion\ntherefore",
    })).toEqual([]);
    expect(validateCertificate(template, { artifact: "## Premises\nfact" })).toEqual([
      "certificate missing section: Conclusion",
    ]);
  });

  it("requires premise citations in the conclusion only after all sections are present", () => {
    const citationsTemplate: CertTemplate = { ...template, require_citations: true };
    expect(validateCertificate(citationsTemplate, {
      artifact: "## Premises\n[P1] fact\n## Conclusion\ntherefore [P1]",
    })).toEqual([]);
    expect(validateCertificate(citationsTemplate, {
      artifact: "## Premises\n[P1] fact\n## Conclusion\ntherefore",
    })).toEqual([
      "certificate violation: conclusion contains no premise citations [P<n>]",
    ]);
    expect(validateCertificate(citationsTemplate, { artifact: "## Premises" })).toEqual([
      "certificate missing section: Conclusion",
    ]);
  });

  it("falls back from an empty artifact to reasoning and handles an empty result", () => {
    expect(validateCertificate(template, {
      artifact: "",
      reasoning: "## Premises\nfact\n## Conclusion\ntherefore",
    })).toEqual([]);
    expect(validateCertificate(template, { artifact: "" })).toEqual([
      "certificate missing section: Premises",
      "certificate missing section: Conclusion",
    ]);
  });
});
