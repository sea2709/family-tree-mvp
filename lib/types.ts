export type Person = {
  id: string;
  displayName: string;
  preferredName?: string | null;
  birthYear?: number | null;
  birthDatePrecision?: "exact" | "year_only" | "circa" | "unknown";
  birthPlace?: string | null;
  deathYear?: number | null;
  bio?: string | null;
  avatarUrl?: string | null;
};

export type RelationshipType = "PARENT_OF" | "SPOUSE_OF" | "PARTNER_OF";

export type Relationship = {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  type: RelationshipType;
};

// A proposal is a candidate fact. Nothing in a proposal touches the
// tree until the user presses Accept. This is the human-in-the-loop
// step from the sketch: it stops the model merging same-name people
// or inventing dates.
export type Proposal = {
  id: string;
  kind: "person" | "relationship";
  // For kind === "person"
  tempId?: string;
  displayName?: string;
  preferredName?: string | null;
  birthYear?: number | null;
  birthPlace?: string | null;
  bio?: string | null;
  // For kind === "relationship". Each side is either an existing
  // person id or a tempId from a person proposal in the same batch.
  fromRef?: string;
  toRef?: string;
  relationshipType?: RelationshipType;
  reason: string;
  confidence: "high" | "medium" | "low";
  // Set by the client when the user picks "this is an existing person".
  // Only used for ambiguous same-name cases.
  existingPersonId?: string | null;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type RosterPerson = {
  id: string;
  displayName: string;
  preferredName?: string | null;
  birthYear?: number | null;
  birthPlace?: string | null;
};
