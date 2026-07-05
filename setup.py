import os

from setuptools import setup, find_packages

here = os.path.abspath(os.path.dirname(__file__))
README = open(os.path.join(here, 'README.txt')).read()
CHANGES = open(os.path.join(here, 'CHANGES.txt')).read()

requires = [
    'pyramid',
    'jinja2',
    'simplejson',
    'transaction',
    'pyramid_tm',
    'pyramid_debugtoolbar',
    'streamlink',
    'waitress',
    ]

setup(name='multitwitch',
      version='1.0.0',
      description='StreamMulti -- a personal multistream control deck for Twitch',
      long_description=README + '\n\n' +  CHANGES,
      classifiers=[
        "Programming Language :: Python",
        "Framework :: Pyramid",
        "License :: OSI Approved :: MIT License",
        "Topic :: Internet :: WWW/HTTP",
        "Topic :: Internet :: WWW/HTTP :: WSGI :: Application",
        ],
      author='Robert McKinnon',
      author_email='',
      url='https://github.com/Brobert-in-aus/multitwitch',
      license='MIT',
      keywords='web wsgi pyramid twitch multistream',
      packages=find_packages(),
      include_package_data=True,
      zip_safe=False,
      test_suite='tests',
      install_requires=requires,
      entry_points="""\
      [paste.app_factory]
      main = multitwitch:main
      """,
      )

