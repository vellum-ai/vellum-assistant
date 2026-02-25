/** Types for the Google People API (Contacts). */

export interface PersonName {
  displayName?: string;
  givenName?: string;
  familyName?: string;
}

export interface PersonEmail {
  value?: string;
  type?: string;
}

export interface PersonPhone {
  value?: string;
  type?: string;
}

export interface PersonOrganization {
  name?: string;
  title?: string;
}

export interface Person {
  resourceName: string;
  names?: PersonName[];
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: PersonOrganization[];
}

export interface PeopleConnectionsResponse {
  connections?: Person[];
  nextPageToken?: string;
  totalPeople?: number;
  totalItems?: number;
}

export interface PeopleSearchResponse {
  results?: Array<{ person: Person }>;
}
