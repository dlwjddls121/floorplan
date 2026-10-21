// App and file-format versions (see dev/DESIGN.md §1, §2).
// APP_VERSION is the human-facing release number shown in the UI and written into project files.
// FILE_FORMAT_VERSION is the project-file schema version. Bump it only when the JSON shape changes in a
// way older apps cannot read; model.validateProject() must then migrate older files forward.
// An app refuses to open or save a project whose `version` is greater than FILE_FORMAT_VERSION
// (plan §8-1: "앱을 업데이트하세요"), so a newer file is never damaged by an older app.
export const APP_VERSION = '0.6.2';   // 0.6.2 2026-10-22: [지우개] 도구 (문지른 것만 지움: 닿은 벽은 한 줄 전체, 창·문·설비·메모·구역 나누기 선은 하나씩, 빨간 미리보기, 한 번에 되돌리기; 점검: T자에서는 가로지르는 벽이 제 띠를 가짐, 겹친 설비는 위의 것만, 벽이 지워져 이어 붙은 벽은 확인필요 표시와 붙은 설비를 그대로 둠); 0.6.1 2026-10-21: [↻ 회전] (도면 돌리기)은 되돌리기 단계가 아님 (↶ / ↷가 방향을 바꾸지 않음, 네 번 누르면 원래대로), '돌리기' → '회전'; 0.6.0 2026-10-20: 사선 벽 (비스듬히 그으면 자동, 그린 각도 유지, 사선 길이로 위치 계산, 사선 치수 표시), 그림 먼저·치수 나중 점검 수정; 0.5.0 2026-10-18: 실 이름 순서, 출력 '치수선 없이' (현장 원본 대신), 도면 돌리기, 설비 흰색, 기본 글꼴; 0.4.1: verifier fixes (screen labels vs fixtures, dimension rows); 0.4.0 2026-10-17 "아직 남은 점": 설정, 글자 옮기기, 벽으로 나눈 치수, 전체 치수 검사; 0.3.0: 구역 나누기, 현장 원본
export const FILE_FORMAT_VERSION = 1;

// Constant that identifies our project files (project.format).
export const FILE_FORMAT_ID = 'habitat-floorplan';
