export interface UserTurnMessage {
  text: string;
  attachments?: { id: string; name: string; path: string; mediaType: string }[];
}
