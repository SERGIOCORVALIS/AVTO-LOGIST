"""Mirror of voice after-hours logic for unit coverage without TS runtime."""

from datetime import datetime


def is_after_hours(
    now: datetime,
    *,
    start: int = 9,
    end: int = 19,
    skip_weekends: bool = True,
) -> bool:
    # Approximate Europe/Moscow as UTC+3 for tests
    local = now
    if skip_weekends and local.weekday() >= 5:
        return True
    return local.hour < start or local.hour >= end


def test_weekday_business_hours():
    # Monday 12:00
    d = datetime(2026, 8, 10, 12, 0, 0)
    assert is_after_hours(d) is False


def test_evening_is_after_hours():
    d = datetime(2026, 8, 10, 20, 0, 0)
    assert is_after_hours(d) is True


def test_sunday_is_after_hours():
    d = datetime(2026, 8, 9, 12, 0, 0)  # Sunday
    assert is_after_hours(d) is True
