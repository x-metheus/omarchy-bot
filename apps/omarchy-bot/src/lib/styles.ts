import * as stylex from "@stylexjs/stylex";


const styles = stylex.create({
  fillColumn: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  composerWrap: {
    width: "100%",
    boxSizing: "border-box",
  },
  composerDropZone: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing-2)",
  },
  hiddenFileInput: {
    display: "none",
  },
  attachmentPreview: {
    width: "100%",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-border)",
    borderRadius: "var(--radius-container)",
    backgroundColor: "var(--color-background-muted)",
  },
  attachmentThumbnail: {
    width: "var(--spacing-12)",
    minWidth: "var(--spacing-12)",
    overflow: "hidden",
    borderRadius: "var(--radius-element)",
    backgroundColor: "var(--color-background-muted)",
  },
  attachmentImage: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  messageContent: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing-2)",
    whiteSpace: "normal",
    minWidth: 0,
  },
  disclosureContent: {
    minHeight: 0,
    overflow: "hidden",
  },
  markdownLink: {
    color: "var(--color-text-accent)",
    textDecoration: "underline",
  },
  markdownImage: {
    display: "block",
    maxWidth: "100%",
    height: "auto",
  },
});

export default styles;
