from common.db import normalize_phone, get_or_create_deal_by_phone


def test_normalize_phone_ru():
    assert normalize_phone("+79991234567") == "+79991234567"
    assert normalize_phone("89991234567") == "+79991234567"
    assert normalize_phone("8 (999) 123-45-67") == "+79991234567"


def test_normalize_phone_intl():
    assert normalize_phone("+8613812345678") == "+8613812345678"
