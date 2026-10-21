-- 独立 Postgres 的初始化。
--
-- 验收存储后端只需要一个干净的库；这里只确认时区与 UUID 扩展可用，
-- 表结构由控制平面或组合包自己建，不在初始化脚本里写死。

create extension if not exists pgcrypto;

alter database chatdsh set timezone to 'UTC';
