import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * Shell for the unauthenticated, public-facing routes (`/`, `/privacy`,
 * `/terms`, `/support`). These are the pages a Shopify App Review reviewer and
 * a prospective merchant see before install, so they deliberately carry no
 * Polaris/App Bridge dependency — nothing here runs inside the admin frame.
 */
export function PublicPage({
  title,
  intro,
  updated,
  children,
}: {
  title: string;
  intro?: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <Link to="/" style={styles.brand}>
          AlertProof
        </Link>
        <nav style={styles.nav}>
          <Link to="/support" style={styles.navLink}>
            Support
          </Link>
          <Link to="/privacy" style={styles.navLink}>
            Privacy
          </Link>
          <Link to="/terms" style={styles.navLink}>
            Terms
          </Link>
        </nav>
      </header>

      <main style={styles.main}>
        <h1 style={styles.h1}>{title}</h1>
        {intro ? <p style={styles.intro}>{intro}</p> : null}
        {updated ? <p style={styles.updated}>Last updated {updated}</p> : null}
        {children}
      </main>

      <footer style={styles.footer}>
        <p style={styles.footerText}>
          AlertProof is an app for Shopify stores. Shopify is a trademark of
          Shopify Inc.; AlertProof is not affiliated with or endorsed by Shopify
          Inc.
        </p>
        <p style={styles.footerText}>
          <Link to="/privacy" style={styles.navLink}>
            Privacy policy
          </Link>
          {" · "}
          <Link to="/terms" style={styles.navLink}>
            Terms of service
          </Link>
          {" · "}
          <Link to="/support" style={styles.navLink}>
            Support
          </Link>
        </p>
      </footer>
    </div>
  );
}

export function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{heading}</h2>
      {children}
    </section>
  );
}

export const styles = {
  page: {
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    color: "#1a1a1a",
    lineHeight: 1.6,
    maxWidth: 760,
    margin: "0 auto",
    padding: "0 1.5rem 4rem",
  },
  header: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "1rem",
    padding: "1.75rem 0",
    borderBottom: "1px solid #e3e3e3",
  },
  brand: {
    fontSize: "1.15rem",
    fontWeight: 700,
    letterSpacing: "-0.01em",
    color: "#1a1a1a",
    textDecoration: "none",
  },
  nav: { display: "flex", gap: "1.25rem", fontSize: "0.95rem" },
  navLink: { color: "#4a4a4a", textDecoration: "underline" },
  main: { paddingTop: "2.5rem" },
  h1: {
    fontSize: "2rem",
    lineHeight: 1.2,
    letterSpacing: "-0.02em",
    margin: "0 0 0.75rem",
  },
  h2: { fontSize: "1.2rem", margin: "2rem 0 0.5rem" },
  h3: { fontSize: "1rem", margin: "1.25rem 0 0.35rem" },
  intro: { fontSize: "1.1rem", color: "#3a3a3a", margin: "0 0 0.5rem" },
  updated: { fontSize: "0.9rem", color: "#6a6a6a", margin: "0 0 1rem" },
  section: { margin: 0 },
  list: { paddingLeft: "1.25rem", margin: "0.5rem 0" },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    margin: "1rem 0",
    fontSize: "0.95rem",
  },
  th: {
    textAlign: "left" as const,
    borderBottom: "2px solid #e3e3e3",
    padding: "0.5rem 0.6rem",
  },
  td: { borderBottom: "1px solid #eee", padding: "0.5rem 0.6rem" },
  footer: {
    marginTop: "3rem",
    paddingTop: "1.5rem",
    borderTop: "1px solid #e3e3e3",
    fontSize: "0.85rem",
    color: "#6a6a6a",
  },
  footerText: { margin: "0 0 0.5rem" },
};
