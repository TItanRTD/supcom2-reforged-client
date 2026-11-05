export type PlaytestStatus='pending'|'approved'|'rejected'|'revoked';
export interface PlaytestApplication {
 accountId:string;revision:number;status:PlaytestStatus;
 experience:'new'|'regular'|'competitive'|null;interests:string;setup:string;
 submittedAt:string|null;updatedAt:string;reviewedAt:string|null;reviewedBy:string|null;
 history:{status:PlaytestStatus;at:string;actor:string}[];
}
export interface PlaytestData {revision:number;applicationsOpen:boolean;applications:PlaytestApplication[]}
export type OwnPlaytestApplication=Omit<PlaytestApplication,'reviewedBy'|'history'>;
export interface PlaytestProfile {
 applicationsOpen:boolean;canDownload:boolean;administrator:boolean;
 application:OwnPlaytestApplication|null;
}
export interface PlaytestAdmin {
 revision:number;applicationsOpen:boolean;
 applications:(PlaytestApplication&{username:string;email:string|null;disabled:boolean})[];
 accounts:{id:string;username:string;administrator:boolean;disabled:boolean}[];
}
