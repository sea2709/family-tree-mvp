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
  // Only known when the chat used a gendered word ("my dad", "his
  // sister", "Thuc's wife"). Lets a later "my dad" pick the right
  // parent from the graph alone.
  gender?: Gender | null;
};

export type Gender = "male" | "female";

export type RelationshipType =
  | "PARENT_OF"
  | "SPOUSE_OF"
  | "PARTNER_OF"
  | "SIBLING_OF";

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
  gender?: Gender | null;
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
  // Person proposal for the speaker ("I'm Lan"). Accepting it sets the
  // tree's ego, whatever order the cards are accepted in.
  isSpeaker?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type RosterPerson = Pick<
  Person,
  "id" | "displayName" | "preferredName" | "birthYear" | "birthPlace" | "gender"
>;

// What the page sends to /api/chat alongside the roster: the edges
// already in the tree. Without these, a second prompt like
// "my dad's brother is Tuan" cannot be resolved — the roster alone
// says Hoa exists, but not that Hoa is Dang's dad.
export type RosterRelationship = Pick<Relationship, "fromPersonId" | "toPersonId" | "type">;

export type ChatHistoryItem = Pick<ChatMessage, "role" | "text">;
