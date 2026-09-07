"""Owner sharing controls through a disposable, actual host-agent HTTP server."""

import http.client
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_pixel_provider_host_api as host_fixture

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='POSIX private state')


@pytest.fixture
def owner(tmp_path):
    host_fixture.HostHTTP.setUpClass()
    agent = host_fixture.HostHTTP.agent
    agent.DATA_DIR = tmp_path
    route = {'catalogId':'glm','runtimeModelId':'GLM','routeSeq':4}
    with patch.object(agent, '_pixel_share_active_route', return_value=route):
        yield agent, host_fixture.HostHTTP.server, route
    host_fixture.HostHTTP.tearDownClass()


def request(owner, action=None, body=None, token='synthetic-provider-test-key'):
    _, server, _ = owner
    connection = http.client.HTTPConnection(*server.server_address, timeout=3)
    try:
        path = '/v1/pixel/inference-sharing' + ('/' + action if action else '')
        connection.request('POST' if action else 'GET', path,
            body=json.dumps(body) if body is not None else None,
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read()), response.getheader('Cache-Control')
    finally:
        connection.close()


def settings():
    return dict(label='Laptop',catalogId='glm',runtimeModelId='GLM',ttlSeconds=3600,
                maxConcurrent=1,maxOutputTokens=64,deadlineSeconds=60,requestsPerMinute=20)


def test_owner_issue_enable_revoke_cas_and_no_secret_readback(owner):
    status, initial, cache = request(owner)
    assert status == 200 and initial['configuration']['revision'] == 0 and cache == 'no-store'
    assert not list(owner[0].DATA_DIR.iterdir())
    status, issued, cache = request(owner,'issue',{'expectedRevision':0,'settings':settings()})
    assert status == 200 and cache == 'no-store'
    key = issued['credential']['key']
    assert key not in json.dumps(request(owner)) and 'tokenHash' not in json.dumps(request(owner))
    from pixel_provider.sharing import SharingStore
    from pixel_provider.store import StoreError
    store = SharingStore(owner[0].DATA_DIR / 'pixel-inference')
    with pytest.raises(StoreError, match='invalid-credential'):
        store.authenticate(key)
    assert request(owner,'enable',{'expectedRevision':1,'enabled':True})[0] == 200
    assert store.authenticate(key)['label'] == 'Laptop'
    assert request(owner,'enable',{'expectedRevision':1,'enabled':False})[0] == 409
    assert request(owner,'revoke',{'expectedRevision':2,'deviceId':issued['credential']['id']})[0] == 200
    with pytest.raises(StoreError, match='invalid-credential'):
        store.authenticate(key)


def test_owner_auth_and_validation_before_persistence(owner):
    assert request(owner,token='bad')[0] == 403
    assert request(owner,'issue',{},token='bad')[0] == 403
    for body in ({}, {'expectedRevision':True,'settings':settings()},
                 {'expectedRevision':0,'settings':{**settings(),'maxConcurrent':999}},
                 {'expectedRevision':0,'settings':settings(),'extra':True}):
        assert request(owner,'issue',body)[0] == 400
    assert request(owner,'issue',{'expectedRevision':0,'settings':{**settings(),'catalogId':'other'}})[0] == 409
    assert not list(owner[0].DATA_DIR.iterdir())


def test_disable_and_revoke_do_not_need_active_route(owner):
    issued = request(owner,'issue',{'expectedRevision':0,'settings':settings()})[1]
    with patch.object(owner[0], '_pixel_share_active_route', return_value=None):
        assert request(owner,'enable',{'expectedRevision':1,'enabled':True})[0] == 409
        assert request(owner,'enable',{'expectedRevision':1,'enabled':False})[0] == 200
        assert request(owner,'revoke',{'expectedRevision':2,'deviceId':issued['credential']['id']})[0] == 200


def test_corrupt_state_is_unavailable_not_empty(owner):
    request(owner,'issue',{'expectedRevision':0,'settings':settings()})
    path = owner[0].DATA_DIR / 'pixel-inference/inference-sharing.json'
    path.write_text('{"secret":"do-not-echo"}')
    status, result, _ = request(owner)
    assert status == 503 and 'do-not-echo' not in json.dumps(result)
