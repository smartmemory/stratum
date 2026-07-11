/** Certificate template for parallel task reasoning output. */
export interface CertTemplate {
  sections: { label: string }[];
  require_citations?: boolean;
}

/**
 * Port of executor.validate_certificate.
 *
 * Validates required headings and, when requested, premise citations in the
 * final (conclusion) section.
 */
export function validateCertificate(template: CertTemplate, result: Record<string, unknown>): string[] {
  const artifact = firstNonEmptyString(result.artifact, result.reasoning);
  const violations: string[] = [];
  const sections = template.sections ?? [];

  for (const section of sections) {
    const heading = `## ${section.label}`;
    if (!artifact.includes(heading)) {
      violations.push(`certificate missing section: ${section.label}`);
    }
  }

  if (template.require_citations && violations.length === 0) {
    if (sections.length === 0) return violations;
    const conclusion = sections[sections.length - 1];
    if (!conclusion) return violations;
    const conclusionIndex = artifact.indexOf(`## ${conclusion.label}`);
    if (conclusionIndex >= 0 && !/\[P\d+\]/.test(artifact.slice(conclusionIndex))) {
      violations.push("certificate violation: conclusion contains no premise citations [P<n>]");
    }
  }

  return violations;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}
